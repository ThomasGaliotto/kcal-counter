"""Limites de débit en mémoire : freine les essais de mots de passe et l'abus d'Ollama."""

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request


def client_ip(request: Request) -> str:
    # Derrière Cloudflare Tunnel, la vraie IP arrive dans CF-Connecting-IP ;
    # derrière Tailscale, --proxy-headers la place déjà dans request.client.
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "?")


class RateLimit:
    def __init__(self, limit: int, window_s: int, message: str):
        self.limit, self.window, self.message = limit, window_s, message
        self.hits: dict[str, deque] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            retry = int(self.window - (now - q[0])) + 1
            raise HTTPException(429, self.message, headers={"Retry-After": str(retry)})
        q.append(now)


# 10 tentatives de connexion / inscription par IP et par quart d'heure
auth_limit = RateLimit(10, 15 * 60, "Trop de tentatives, réessaie dans quelques minutes")
# 60 analyses par compte et par heure (photo, texte, correction, ingrédient)
ai_limit = RateLimit(60, 60 * 60, "Trop d'analyses en peu de temps, réessaie plus tard")


def limit_auth(request: Request) -> None:
    auth_limit.check(client_ip(request))
