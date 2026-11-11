-- Onboarding "star us on GitHub" bonus. The baseline is the repo's stargazer
-- count when the person went to star it; bonus_at is when the credits landed.
ALTER TABLE orgs ADD COLUMN github_star_baseline INTEGER;
ALTER TABLE orgs ADD COLUMN github_star_bonus_at INTEGER;
