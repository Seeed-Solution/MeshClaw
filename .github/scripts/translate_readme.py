#!/usr/bin/env python3
"""Translate README.md to target languages using an OpenAI-compatible LLM API."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "README.md"
TRANSLATE_DIR = ROOT / ".github" / "translate"
LANGUAGES_FILE = TRANSLATE_DIR / "languages.json"
GLOSSARY_DIR = TRANSLATE_DIR / "glossary"
PROMPTS_DIR = TRANSLATE_DIR / "prompts"
DO_NOT_TRANSLATE_FILE = TRANSLATE_DIR / "do-not-translate.md"

API_URL = os.environ.get(
    "LLM_BASE_URL", "https://api.kimi.com/coding/v1/chat/completions"
)
MODEL = os.environ.get("LLM_MODEL", "kimi-for-coding")
API_KEY_VAR = "LLM_API_KEY"
TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "300"))

_SHARED_RULES = (
    "- Preserve markdown structure exactly: headings, links, tables, inline code, image paths\n"
    "- Do not translate URLs, package names, commands, file paths, env vars\n"
    "- CRITICAL: NEVER translate content inside code fences (```...```). "
    "Copy every fenced code block BYTE-FOR-BYTE from the source, including the opening "
    "language tag and every line inside. This applies to ALL code fences: bash, yaml, "
    "mermaid, and any other language.\n"
    '  BAD:  ```mermaid\\n    subgraph mesh ["translated text"]\\n  ```\n'
    '  GOOD: ```mermaid\\nflowchart LR\\n    subgraph mesh ["LoRa Mesh Network"]\\n  ```\n'
    "  (The GOOD version is identical to the English source — that is the requirement.)\n"
    "- CRITICAL: Table of Contents anchors MUST match the translated heading text. "
    "GitHub generates anchors from heading text, so the TOC link anchor must use "
    "the TRANSLATED heading, not the English original.\n"
    "- Keep line breaks and section order identical\n"
    "- Return only the translated markdown, no explanation\n"
)


@dataclass(frozen=True)
class LangConfig:
    code: str
    name: str
    label: str
    target_file: str
    toc_heading_pattern: str
    glossary: str
    style_prompt: str


def _strip_markdown_fence(text: str) -> str:
    stripped = text.strip()
    match = re.match(r"^```(?:markdown|md)?\n([\s\S]*?)\n```$", stripped, re.IGNORECASE)
    if match:
        return match.group(1).strip() + "\n"
    return text


def _load_languages() -> list[LangConfig]:
    if not LANGUAGES_FILE.exists():
        raise FileNotFoundError(f"Missing languages config file: {LANGUAGES_FILE}")

    parsed = json.loads(LANGUAGES_FILE.read_text(encoding="utf-8"))
    if not isinstance(parsed, list):
        raise ValueError(f"Invalid {LANGUAGES_FILE}: expected top-level list")

    languages: list[LangConfig] = []
    for idx, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            raise ValueError(f"Invalid language entry at index {idx}: expected object")

        code = str(entry.get("code", "")).strip()
        name = str(entry.get("name", "")).strip()
        label = str(entry.get("label", "")).strip()
        target = str(entry.get("target", "")).strip()
        toc_pattern = str(entry.get("toc_pattern", "")).strip()

        if not all([code, name, label, target, toc_pattern]):
            raise ValueError(
                f"Invalid language entry at index {idx}: code, name, label, target, toc_pattern are required",
            )

        glossary_path = GLOSSARY_DIR / f"{code}.md"
        prompt_path = PROMPTS_DIR / f"{code}.md"
        if not glossary_path.exists():
            raise FileNotFoundError(
                f"Missing glossary file for {code}: {glossary_path}"
            )
        if not prompt_path.exists():
            raise FileNotFoundError(f"Missing prompt file for {code}: {prompt_path}")

        languages.append(
            LangConfig(
                code=code,
                name=name,
                label=label,
                target_file=target,
                toc_heading_pattern=toc_pattern,
                glossary=glossary_path.read_text(encoding="utf-8").strip(),
                style_prompt=prompt_path.read_text(encoding="utf-8").strip(),
            )
        )

    return languages


def _build_lang_switcher(current_file: str, languages: list[LangConfig]) -> str:
    links: list[str] = []

    if current_file == "README.md":
        links.append("<b>English</b>")
    else:
        links.append('<a href="README.md">English</a>')

    for lang in languages:
        if current_file == lang.target_file:
            links.append(f"<b>{lang.label}</b>")
        else:
            links.append(f'<a href="{lang.target_file}">{lang.label}</a>')

    return (
        '<!-- LANG_SWITCHER_START -->\n<p align="center">\n  '
        + " | ".join(links)
        + "\n</p>\n<!-- LANG_SWITCHER_END -->"
    )


def _fix_lang_switcher(
    translated: str, current_file: str, languages: list[LangConfig]
) -> str:
    pattern = re.compile(
        r"<!-- LANG_SWITCHER_START -->[\s\S]*?<!-- LANG_SWITCHER_END -->",
        re.IGNORECASE,
    )
    replacement = _build_lang_switcher(current_file, languages)
    result, count = pattern.subn(replacement, translated, count=1)
    if count == 0:
        print(
            f"Warning: language switcher anchors not found in {current_file}; skipping switcher rewrite.",
            file=sys.stderr,
        )
        return translated
    return result


def _extract_code_blocks(md: str) -> list[str]:
    return re.findall(r"^```[^\n]*\n[\s\S]*?^```", md, re.MULTILINE)


def _extract_headings(md: str) -> list[tuple[str, str]]:
    return re.findall(r"^(#{2,})\s+(.+)$", md, re.MULTILINE)


def _github_anchor(heading_text: str) -> str:
    anchor = heading_text.strip().lower()
    anchor = re.sub(r"[^\w\s\u3000-\u9fff\uac00-\ud7af-]", "", anchor)
    anchor = re.sub(r"\s+", "-", anchor)
    return anchor


def _extract_toc_links(md: str, toc_heading_pattern: str) -> list[str]:
    toc_section = re.search(
        rf"^##\s+.*(?:{toc_heading_pattern}).*\n([\s\S]*?)(?=\n##\s)",
        md,
        re.MULTILINE,
    )
    if not toc_section:
        return []
    return re.findall(
        r"\[.*?\]\(#([\w\u3000-\u9fff\uac00-\ud7af-]+)\)", toc_section.group(1)
    )


def _validate_translation(
    source: str,
    translated: str,
    lang: LangConfig,
) -> list[str]:
    errors: list[str] = []

    if not translated.strip().startswith("#"):
        errors.append("Translation does not start with a heading (#)")
    if len(translated) < len(source) * 0.3:
        errors.append(
            f"Translation suspiciously short ({len(translated)} chars vs "
            f"source {len(source)} chars — under 30%)",
        )

    source_blocks = _extract_code_blocks(source)
    translated_blocks = _extract_code_blocks(translated)
    if len(source_blocks) != len(translated_blocks):
        errors.append(
            f"Code block count mismatch: source has {len(source_blocks)}, "
            f"translation has {len(translated_blocks)}",
        )
    else:
        for i, (src_block, trans_block) in enumerate(
            zip(source_blocks, translated_blocks),
        ):
            if src_block != trans_block:
                first_line = src_block.split("\n", 1)[0]
                errors.append(
                    f"Code block {i + 1} ({first_line}) was modified in translation",
                )

    source_headings = _extract_headings(source)
    translated_headings = _extract_headings(translated)
    if len(source_headings) != len(translated_headings):
        errors.append(
            f"Heading count mismatch: source has {len(source_headings)}, "
            f"translation has {len(translated_headings)}",
        )

    toc_links = _extract_toc_links(translated, lang.toc_heading_pattern)
    heading_anchors = {_github_anchor(text) for _, text in translated_headings}
    for link in toc_links:
        if link not in heading_anchors:
            errors.append(f"TOC link #{link} does not match any heading anchor")

    source_refs = set(re.findall(r"^\[[\w-]+\]:\s+", source, re.MULTILINE))
    translated_refs = set(re.findall(r"^\[[\w-]+\]:\s+", translated, re.MULTILINE))
    missing_refs = source_refs - translated_refs
    if missing_refs:
        errors.append(f"Missing reference-style links: {missing_refs}")

    source_html = re.findall(r"<(?:p|div|img|a)\b[^>]*>", source, re.IGNORECASE)
    translated_html = re.findall(r"<(?:p|div|img|a)\b[^>]*>", translated, re.IGNORECASE)
    if len(source_html) != len(translated_html):
        errors.append(
            f"HTML tag count mismatch: source has {len(source_html)}, "
            f"translation has {len(translated_html)}",
        )

    return errors


def _request_translation(
    source_markdown: str,
    api_key: str,
    lang: LangConfig,
    do_not_translate: str,
) -> str:
    system_prompt = (
        lang.style_prompt
        + _SHARED_RULES
        + "\n"
        + lang.glossary
        + "\n"
        + do_not_translate
    )

    payload = {
        "model": MODEL,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": f"Translate the following README markdown to {lang.name}:\n\n"
                + source_markdown,
            },
        ],
    }

    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "claude-code/2.1.71",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LLM API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"LLM API request failed: {exc}") from exc

    parsed = json.loads(body)
    choices = parsed.get("choices")
    if not choices:
        raise RuntimeError(f"LLM API returned no choices: {body}")

    content = choices[0].get("message", {}).get("content", "")
    if not content:
        raise RuntimeError(f"LLM API returned empty content: {body}")

    return _strip_markdown_fence(content)


def _translate_one(
    source_markdown: str,
    api_key: str,
    lang: LangConfig,
    do_not_translate: str,
    languages: list[LangConfig],
) -> int:
    target = ROOT / lang.target_file
    translated = _request_translation(source_markdown, api_key, lang, do_not_translate)

    translated = _fix_lang_switcher(translated, lang.target_file, languages)

    errors = _validate_translation(source_markdown, translated, lang)
    if errors:
        print(f"Translation validation warnings ({lang.code}):", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)

    target.write_text(translated, encoding="utf-8")

    print(
        f"Translated {SOURCE.name} -> {lang.target_file} ({lang.name}) using model {MODEL}."
    )
    if errors:
        print(f"  ({len(errors)} validation warning(s) — see stderr)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Translate README.md via OpenAI-compatible LLM API"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--lang",
        help="Target language code (from .github/translate/languages.json)",
    )
    group.add_argument(
        "--all",
        action="store_true",
        help="Translate all languages from .github/translate/languages.json",
    )
    args = parser.parse_args()

    api_key = os.environ.get(API_KEY_VAR)
    if not api_key:
        print(f"{API_KEY_VAR} is not set; skipping translation.")
        return 0

    if not SOURCE.exists():
        raise FileNotFoundError(f"Missing source file: {SOURCE}")
    if not DO_NOT_TRANSLATE_FILE.exists():
        raise FileNotFoundError(
            f"Missing do-not-translate file: {DO_NOT_TRANSLATE_FILE}"
        )

    source_markdown = SOURCE.read_text(encoding="utf-8")
    do_not_translate = DO_NOT_TRANSLATE_FILE.read_text(encoding="utf-8").strip()
    languages = _load_languages()
    lang_map = {lang.code: lang for lang in languages}

    # Sync English README.md lang switcher from languages.json
    updated_source = _fix_lang_switcher(source_markdown, "README.md", languages)
    if updated_source != source_markdown:
        SOURCE.write_text(updated_source, encoding="utf-8")
        source_markdown = updated_source
        print("Updated language switcher in README.md.")

    if args.lang:
        lang = lang_map.get(args.lang)
        if lang is None:
            allowed = ", ".join(sorted(lang_map.keys()))
            raise ValueError(f"Unsupported --lang '{args.lang}'. Allowed: {allowed}")
        return _translate_one(
            source_markdown, api_key, lang, do_not_translate, languages
        )

    status = 0
    for lang in languages:
        try:
            _translate_one(source_markdown, api_key, lang, do_not_translate, languages)
        except Exception as exc:
            status = 1
            print(f"Translation failed for {lang.code}: {exc}", file=sys.stderr)
    return status


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Translation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
