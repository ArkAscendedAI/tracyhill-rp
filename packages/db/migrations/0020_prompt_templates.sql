CREATE TABLE `prompt_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `name` text NOT NULL,
  `content` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
