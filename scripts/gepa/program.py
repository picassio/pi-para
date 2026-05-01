"""DSPy Module proxy for prompt optimization.

Each optimization target is wrapped in a lightweight proxy module.
The Signature's docstring (instruction) IS the prompt being optimized.
GEPA evolves the instruction to maximize the metric.

One LLM call per eval (not 10-50 like the full agent loop).
"""

from __future__ import annotations

import dspy


class WikiTaskOutput(dspy.Signature):
    """You are a wiki knowledge management agent for a PARA-structured knowledge base."""

    task_context: str = dspy.InputField(
        desc="Context describing the wiki task to perform"
    )
    output: str = dspy.OutputField(
        desc="Structured wiki output following PARA conventions: "
        "Topic, Key Facts, Insights, Connections with [[wikilinks]], Sources"
    )


class PromptProxy(dspy.Module):
    """Lightweight proxy for prompt/instruction optimization.

    The Signature's instruction text is what GEPA evolves.
    forward() runs a single dspy.Predict call (1 LLM call).

    Usage:
        proxy = PromptProxy.from_instruction(current_prompt_text)
        # GEPA optimizes proxy → evolved instruction = optimized prompt
    """

    def __init__(self, instruction: str | None = None):
        super().__init__()

        if instruction:
            # Create a signature class with the instruction as docstring
            class CustomSig(WikiTaskOutput):
                pass
            CustomSig.__doc__ = instruction
            self.predict = dspy.Predict(CustomSig)
        else:
            self.predict = dspy.Predict(WikiTaskOutput)

    def forward(self, task_context: str) -> dspy.Prediction:
        return self.predict(task_context=task_context)

    @classmethod
    def from_instruction(cls, instruction: str) -> "PromptProxy":
        """Create a proxy from a prompt/instruction string."""
        return cls(instruction=instruction)

    def get_instruction(self) -> str | None:
        """Get the current instruction text."""
        sig = getattr(self.predict, "signature", None)
        if sig:
            inst = getattr(sig, "instructions", None)
            if inst and not inst.startswith("str(object"):
                return inst
            doc = getattr(sig, "__doc__", None)
            if doc and not doc.startswith("str(object"):
                return doc
        return None


def extract_evolved_instruction(optimized_proxy: PromptProxy) -> str | None:
    """Extract the GEPA-evolved instruction from an optimized proxy.

    After GEPA optimization, the proxy's Predict signature contains
    the evolved instruction text. This extracts it.
    """
    # Check predict.signature first
    if hasattr(optimized_proxy, "predict"):
        pred = optimized_proxy.predict
        for attr_name in ("extended_signature", "signature"):
            sig = getattr(pred, attr_name, None)
            if sig:
                for field in ("instructions", "__doc__"):
                    text = getattr(sig, field, None)
                    if text and len(text) > 50 and not text.startswith("str(object"):
                        return text

    # Fallback to named_predictors
    try:
        for name, predictor in optimized_proxy.named_predictors():
            sig = getattr(predictor, "signature", None)
            if sig:
                inst = getattr(sig, "instructions", None) or getattr(sig, "__doc__", None)
                if inst and len(inst) > 50 and not inst.startswith("str(object"):
                    return inst
    except Exception:
        pass

    return None
