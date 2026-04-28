"""MiniMax LM for DSPy.

MiniMax provides an Anthropic-compatible API at a custom base URL.
This module wraps the Anthropic SDK to work with MiniMax endpoints.

MiniMax Models:
- MiniMax-M2: 196K context, 128K output, reasoning capable
- MiniMax-M2.1: 196K context, 128K output, reasoning capable

Endpoints:
- International: https://api.minimax.io/anthropic
- China: https://api.minimaxi.com/anthropic
"""

from __future__ import annotations

import logging
import os
from typing import Any, Literal

import anthropic
from dspy.clients.base_lm import BaseLM

logger = logging.getLogger(__name__)

# MiniMax API endpoints
MINIMAX_BASE_URL = "https://api.minimax.io/anthropic"
MINIMAX_CN_BASE_URL = "https://api.minimaxi.com/anthropic"


def get_minimax_api_key(china: bool = False) -> str | None:
    """Get MiniMax API key from environment."""
    if china:
        return os.environ.get("MINIMAX_CN_API_KEY")
    return os.environ.get("MINIMAX_API_KEY")


class MiniMaxLM(BaseLM):
    """DSPy-compatible LM for MiniMax models via Anthropic-compatible API.
    
    MiniMax provides an Anthropic Messages API compatible endpoint,
    so we use the Anthropic SDK with a custom base URL.
    """
    
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
        """Initialize MiniMax LM.
        
        Args:
            model: Model ID (e.g., "MiniMax-M2", "MiniMax-M2.1")
            api_key: MiniMax API key (or from MINIMAX_API_KEY env var)
            china: Use China endpoint (api.minimaxi.com) instead of international
            temperature: Sampling temperature
            max_tokens: Maximum tokens to generate
        """
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
        
        # Get API key
        self._api_key = api_key or get_minimax_api_key(china)
        if not self._api_key:
            env_var = "MINIMAX_CN_API_KEY" if china else "MINIMAX_API_KEY"
            raise ValueError(f"No MiniMax API key found. Set {env_var} environment variable.")
        
        # Create Anthropic client with MiniMax base URL
        self._base_url = MINIMAX_CN_BASE_URL if china else MINIMAX_BASE_URL
        self._client = anthropic.Anthropic(
            api_key=self._api_key,
            base_url=self._base_url,
            default_headers={
                "accept": "application/json",
            },
        )
    
    def __getstate__(self) -> dict:
        """Get state for pickling - exclude non-picklable client."""
        state = self.__dict__.copy()
        state.pop('_client', None)
        return state
    
    def __setstate__(self, state: dict) -> None:
        """Restore state from pickle - recreate client."""
        self.__dict__.update(state)
        self._client = anthropic.Anthropic(
            api_key=self._api_key,
            base_url=self._base_url,
            default_headers={"accept": "application/json"},
        )
    
    def _convert_messages(self, messages: list[dict]) -> tuple[list[dict], str | None]:
        """Convert to Anthropic message format."""
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
        
        return converted, system
    
    def __call__(
        self,
        prompt: str | None = None,
        messages: list[dict] | None = None,
        **kwargs,
    ) -> list[dict]:
        """Call the MiniMax API.
        
        Args:
            prompt: Single prompt string
            messages: List of messages (OpenAI format)
            **kwargs: Additional parameters
            
        Returns:
            List of response dicts with 'text' key (DSPy format)
        """
        # Build messages
        if messages is None:
            messages = []
        if prompt:
            messages = [{"role": "user", "content": prompt}]
        
        # Convert to Anthropic format
        converted_messages, system = self._convert_messages(messages)
        
        # Build request kwargs
        request_kwargs: dict[str, Any] = {
            "model": self._model_id,
            "messages": converted_messages,
            "max_tokens": kwargs.get("max_tokens", self._max_tokens),
            "temperature": kwargs.get("temperature", self._temperature),
        }
        
        if system:
            request_kwargs["system"] = system
        
        # Call API with streaming to support large max_tokens
        # The Anthropic SDK requires streaming for operations > 10 minutes
        try:
            text = ""
            with self._client.messages.stream(**request_kwargs) as stream:
                for chunk in stream.text_stream:
                    text += chunk
        except anthropic.APIError as e:
            logger.error("MiniMax API error: %s", e)
            raise ValueError(f"MiniMax API error: {e}")
        
        # Update history for BaseLM
        self.history.append({
            "prompt": prompt,
            "messages": messages,
            "kwargs": kwargs,
            "response": {"text": text},
        })
        
        # Return in DSPy format
        return [{"text": text}]


def create_minimax_lm(model: str = "MiniMax-M2", china: bool = False, **kwargs) -> MiniMaxLM:
    """Create a MiniMax LM instance.
    
    Args:
        model: Model ID (without minimax/ prefix)
        china: Use China endpoint
        **kwargs: Additional parameters
    """
    if model.startswith("minimax/"):
        model = model[8:]
    return MiniMaxLM(model=model, china=china, **kwargs)
