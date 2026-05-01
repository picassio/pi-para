"""Custom DSPy LM providers — no litellm.

Provides BaseLM subclasses for:
- Anthropic with OAuth token support + Claude Code headers
- MiniMax via Anthropic-compatible API
- OpenRouter via OpenAI-compatible API

API keys are passed via environment variables by the TypeScript orchestrator.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Literal

import anthropic
import openai
from dspy.clients.base_lm import BaseLM

logger = logging.getLogger(__name__)

# -- Constants ----------------------------------------------------------------

CLAUDE_CODE_VERSION = "2.1.96"

MINIMAX_BASE_URL = "https://api.minimax.io/anthropic"
MINIMAX_CN_BASE_URL = "https://api.minimaxi.com/anthropic"

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


# -- Anthropic OAuth LM -------------------------------------------------------

class AnthropicOAuthLM(BaseLM):
    """DSPy LM for Anthropic with OAuth token + Claude Code billing headers.

    Bypasses litellm entirely. Uses anthropic SDK with streaming to avoid
    10-minute timeout on large max_tokens.

    Supports both OAuth tokens (sk-ant-oat*) and regular API keys (sk-ant-api*).
    OAuth tokens route billing through Claude Code subscription (free for Pro/Max).
    """

    def __init__(
        self,
        model: str = "claude-sonnet-4-20250514",
        api_key: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        cache: bool = True,
        num_retries: int = 3,
        model_type: Literal["chat", "text"] = "chat",
        **kwargs,
    ):
        self.model = model.split("/")[-1] if "/" in model else model
        self.model_type = model_type
        self.cache = cache
        self.num_retries = num_retries
        self.history = []
        self.callbacks = []
        self.provider = None
        self.finetuning_model = None
        self.launch_kwargs = {}
        self.train_kwargs = {}

        self.kwargs = {
            "temperature": temperature or 0.0,
            "max_tokens": max_tokens or 8192,
        }

        # Resolve API key
        self._auth_token = api_key or os.environ.get("ANTHROPIC_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
        if not self._auth_token:
            raise ValueError("No Anthropic API key. Set ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN.")

        self._is_oauth = "sk-ant-oat" in self._auth_token

        # Build client with appropriate headers
        if self._is_oauth:
            default_headers = {
                "accept": "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                "anthropic-beta": f"claude-code-20250219,oauth-2025-04-20",
                "user-agent": f"claude-cli/{CLAUDE_CODE_VERSION} (external, cli)",
                "x-app": "cli",
            }
            self._client = anthropic.Anthropic(
                api_key=None,
                auth_token=self._auth_token,
                max_retries=num_retries,
                default_headers=default_headers,
            )
            logger.info("AnthropicOAuthLM: model=%s auth=OAuth", self.model)
        else:
            self._client = anthropic.Anthropic(
                api_key=self._auth_token,
                max_retries=num_retries,
            )
            logger.info("AnthropicOAuthLM: model=%s auth=APIKey", self.model)

    def __call__(
        self,
        prompt: str | None = None,
        messages: list[dict] | None = None,
        **kwargs,
    ) -> list[dict]:
        """Call Anthropic API. Returns list of dicts with 'text' key."""
        if messages is None:
            messages = []
        if prompt:
            messages = [{"role": "user", "content": prompt}]

        # Separate system from messages
        converted, system = self._convert_messages(messages)

        gen_kwargs = {**self.kwargs, **kwargs}
        temperature = gen_kwargs.pop("temperature", 0.0)
        max_tokens = gen_kwargs.pop("max_tokens", 8192)

        # Remove unsupported kwargs
        for key in ["response_format", "n", "stop", "logprobs", "top_logprobs",
                     "presence_penalty", "frequency_penalty", "logit_bias", "user"]:
            gen_kwargs.pop(key, None)

        create_kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": converted,
            "max_tokens": max_tokens,
        }
        if temperature is not None:
            create_kwargs["temperature"] = temperature

        # System prompt — for OAuth, prepend CC identity block
        if self._is_oauth:
            system_blocks = [
                {
                    "type": "text",
                    "text": "You are Claude Code, Anthropic's official CLI for Claude.",
                    "cache_control": {"type": "ephemeral"},
                }
            ]
            if system:
                system_blocks.append({
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                })
            create_kwargs["system"] = system_blocks
        elif system:
            create_kwargs["system"] = system

        # Stream to avoid 10-minute timeout
        text = ""
        try:
            with self._client.messages.stream(**create_kwargs) as stream:
                for chunk in stream.text_stream:
                    text += chunk
        except anthropic.APIError as e:
            logger.error("Anthropic API error: %s", e)
            raise ValueError(f"Anthropic API error: {e}")

        self.history.append({
            "prompt": prompt,
            "messages": messages,
            "kwargs": kwargs,
            "response": {"text": text},
        })
        return [{"text": text}]

    def _convert_messages(self, messages: list[dict]) -> tuple[list[dict], str | None]:
        converted = []
        system = None
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                system = f"{system}\n\n{content}" if system else content
            elif role == "assistant":
                converted.append({"role": "assistant", "content": content})
            else:
                converted.append({"role": "user", "content": content})
        return converted, system

    def __getstate__(self) -> dict:
        state = self.__dict__.copy()
        state.pop("_client", None)
        return state

    def __setstate__(self, state: dict) -> None:
        self.__dict__.update(state)
        if self._is_oauth:
            self._client = anthropic.Anthropic(
                api_key=None, auth_token=self._auth_token,
                max_retries=self.num_retries,
                default_headers={
                    "accept": "application/json",
                    "anthropic-dangerous-direct-browser-access": "true",
                    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
                    "user-agent": f"claude-cli/{CLAUDE_CODE_VERSION} (external, cli)",
                    "x-app": "cli",
                },
            )
        else:
            self._client = anthropic.Anthropic(api_key=self._auth_token, max_retries=self.num_retries)


# -- MiniMax LM ---------------------------------------------------------------

class MiniMaxLM(BaseLM):
    """DSPy LM for MiniMax via Anthropic-compatible API."""

    def __init__(
        self,
        model: str = "MiniMax-M2",
        api_key: str | None = None,
        china: bool = False,
        temperature: float | None = None,
        max_tokens: int | None = None,
        cache: bool = True,
        num_retries: int = 3,
        model_type: Literal["chat", "text"] = "chat",
        **kwargs,
    ):
        super().__init__(
            model=f"minimax/{model}" if not model.startswith("minimax/") else model,
            model_type=model_type,
            temperature=temperature or 0.0,
            max_tokens=max_tokens or 8192,
            cache=cache,
            num_retries=num_retries,
        )
        self._model_id = model.replace("minimax/", "") if model.startswith("minimax/") else model
        self._china = china
        self._temperature = temperature or 0.0
        self._max_tokens = max_tokens or 8192
        self._base_url = MINIMAX_CN_BASE_URL if china else MINIMAX_BASE_URL

        env_var = "MINIMAX_CN_API_KEY" if china else "MINIMAX_API_KEY"
        self._api_key = api_key or os.environ.get(env_var)
        if not self._api_key:
            raise ValueError(f"No MiniMax API key. Set {env_var}.")

        self._client = anthropic.Anthropic(
            api_key=self._api_key,
            base_url=self._base_url,
            default_headers={"accept": "application/json"},
        )
        logger.info("MiniMaxLM: model=%s endpoint=%s", self._model_id, self._base_url)

    def __call__(
        self,
        prompt: str | None = None,
        messages: list[dict] | None = None,
        **kwargs,
    ) -> list[dict]:
        if messages is None:
            messages = []
        if prompt:
            messages = [{"role": "user", "content": prompt}]

        converted = []
        system = None
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                system = content
            elif role == "assistant":
                converted.append({"role": "assistant", "content": content})
            else:
                converted.append({"role": "user", "content": content})

        request_kwargs: dict[str, Any] = {
            "model": self._model_id,
            "messages": converted,
            "max_tokens": kwargs.get("max_tokens", self._max_tokens),
            "temperature": kwargs.get("temperature", self._temperature),
        }
        if system:
            request_kwargs["system"] = system

        text = ""
        try:
            with self._client.messages.stream(**request_kwargs) as stream:
                for chunk in stream.text_stream:
                    text += chunk
        except anthropic.APIError as e:
            logger.error("MiniMax API error: %s", e)
            raise ValueError(f"MiniMax API error: {e}")

        self.history.append({"prompt": prompt, "messages": messages, "response": {"text": text}})
        return [{"text": text}]

    def __getstate__(self) -> dict:
        state = self.__dict__.copy()
        state.pop("_client", None)
        return state

    def __setstate__(self, state: dict) -> None:
        self.__dict__.update(state)
        self._client = anthropic.Anthropic(
            api_key=self._api_key, base_url=self._base_url,
            default_headers={"accept": "application/json"},
        )


# -- OpenRouter LM ------------------------------------------------------------

class OpenRouterLM(BaseLM):
    """DSPy LM for OpenRouter via OpenAI-compatible API."""

    def __init__(
        self,
        model: str = "anthropic/claude-sonnet-4",
        api_key: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        cache: bool = True,
        num_retries: int = 3,
        model_type: Literal["chat", "text"] = "chat",
        **kwargs,
    ):
        super().__init__(
            model=f"openrouter/{model}" if not model.startswith("openrouter/") else model,
            model_type=model_type,
            temperature=temperature or 0.0,
            max_tokens=max_tokens or 8192,
            cache=cache,
            num_retries=num_retries,
        )
        self._model_id = model.replace("openrouter/", "") if model.startswith("openrouter/") else model
        self._temperature = temperature or 0.0
        self._max_tokens = max_tokens or 8192

        self._api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not self._api_key:
            raise ValueError("No OpenRouter API key. Set OPENROUTER_API_KEY.")

        self._client = openai.OpenAI(
            api_key=self._api_key,
            base_url=OPENROUTER_BASE_URL,
        )
        logger.info("OpenRouterLM: model=%s", self._model_id)

    def __call__(
        self,
        prompt: str | None = None,
        messages: list[dict] | None = None,
        **kwargs,
    ) -> list[dict]:
        if messages is None:
            messages = []
        if prompt:
            messages = [{"role": "user", "content": prompt}]

        response = self._client.chat.completions.create(
            model=self._model_id,
            messages=messages,
            temperature=kwargs.get("temperature", self._temperature),
            max_tokens=kwargs.get("max_tokens", self._max_tokens),
        )
        text = response.choices[0].message.content or ""
        self.history.append({"prompt": prompt, "messages": messages, "response": {"text": text}})
        return [{"text": text}]

    def __getstate__(self) -> dict:
        state = self.__dict__.copy()
        state.pop("_client", None)
        return state

    def __setstate__(self, state: dict) -> None:
        self.__dict__.update(state)
        self._client = openai.OpenAI(api_key=self._api_key, base_url=OPENROUTER_BASE_URL)


# -- Factory ------------------------------------------------------------------

def create_lm(model_spec: str, **kwargs) -> BaseLM:
    """Create a DSPy LM from a provider/model spec string.

    Supported formats:
      anthropic/claude-sonnet-4-20250514
      minimax/MiniMax-M2
      minimax-cn/MiniMax-M2       (China endpoint)
      openrouter/anthropic/claude-sonnet-4
      openrouter/openai/gpt-4o

    API keys from env vars:
      ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN
      MINIMAX_API_KEY or MINIMAX_CN_API_KEY
      OPENROUTER_API_KEY
    """
    parts = model_spec.split("/", 1)
    if len(parts) < 2:
        raise ValueError(f"Model spec must be 'provider/model': {model_spec}")

    provider, model_id = parts[0], parts[1]

    if provider == "anthropic":
        return AnthropicOAuthLM(model=model_id, **kwargs)
    elif provider == "minimax":
        return MiniMaxLM(model=model_id, china=False, **kwargs)
    elif provider == "minimax-cn":
        return MiniMaxLM(model=model_id, china=True, **kwargs)
    elif provider == "openrouter":
        return OpenRouterLM(model=model_id, **kwargs)
    else:
        raise ValueError(f"Unknown provider '{provider}'. Use: anthropic, minimax, minimax-cn, openrouter")
