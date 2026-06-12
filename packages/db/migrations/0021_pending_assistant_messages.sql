CREATE TABLE `pending_assistant_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `user_id` text NOT NULL,
  `source_user_message_id` text NOT NULL,
  `model_id` text NOT NULL,
  `content` text NOT NULL,
  `input_tokens` integer,
  `output_tokens` integer,
  `total_tokens` integer,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
