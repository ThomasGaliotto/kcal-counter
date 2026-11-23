"""In-memory rate limits: slow down password guessing and Ollama abuse."""

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request


def client_ip(request: Request) -> str:
    # Behind Cloudflare Tunnel, the real IP comes in CF-Connecting-IP;
    # behind Tailscale, --proxy-headers already puts it in request.client.
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


# 10 login / sign-up attempts per IP every 15 minutes
auth_limit = RateLimit(10, 15 * 60, "Trop de tentatives, réessaie dans quelques minutes")
# 60 analyses per account per hour (photo, text, correction, ingredient)
ai_limit = RateLimit(60, 60 * 60, "Trop d'analyses en peu de temps, réessaie plus tard")


def limit_auth(request: Request) -> None:
    auth_limit.check(client_ip(request))
