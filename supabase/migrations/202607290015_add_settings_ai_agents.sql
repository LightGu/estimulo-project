ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS ai_agents jsonb NOT NULL DEFAULT '{
      "transcription": {
        "models": ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"]
      },
      "caption_generation": {
        "models": ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-2.5-flash-lite"],
        "prompt": null
      },
      "caption_review": {
        "models": ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-2.5-flash-lite"],
        "prompt": null
      }
    }'::jsonb;
