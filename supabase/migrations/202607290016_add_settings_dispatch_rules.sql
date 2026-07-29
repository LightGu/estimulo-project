ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS dispatch_rules jsonb NOT NULL DEFAULT '{
      "never_repeat_video": true,
      "notify_on_trail_finished": true,
      "auto_generate_caption": true,
      "require_human_review": true,
      "auto_send_after_timeout": {"enabled": false, "minutes": 60},
      "auto_retry_failures": true
    }'::jsonb;
