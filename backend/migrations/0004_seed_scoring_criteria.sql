-- Migration number: 0004 	 2026-08-29T00:00:00.000Z
-- The rubric. Weights sum to 100, so a card's weighted average lands on the
-- 0-10 scale as a straight percentage of the maximum.
--
-- Ids are minted here with randomblob(16), which yields the same 32 lowercase
-- hex characters the application's generateId() produces, so seeded rows are
-- indistinguishable from ones created over the API.

INSERT INTO scoring_criteria (id, name, description, weight) VALUES
  ('crit_' || lower(hex(randomblob(16))), 'Rewards / Returns',
   'Effective reward rate and redemption value', 30),
  ('crit_' || lower(hex(randomblob(16))), 'Travel Benefits',
   'Lounges, airline/hotel transfers, travel perks', 20),
  ('crit_' || lower(hex(randomblob(16))), 'Lifestyle Benefits',
   'Hotels, dining, golf, memberships, concierge', 15),
  ('crit_' || lower(hex(randomblob(16))), 'Exclusivity / Prestige',
   'Invite-only status, eligibility, perceived premium positioning', 15),
  ('crit_' || lower(hex(randomblob(16))), 'Milestone / Welcome Benefits',
   'Welcome bonuses and spend milestones', 10),
  ('crit_' || lower(hex(randomblob(16))), 'Forex / International',
   'Forex markup and international usability', 5),
  ('crit_' || lower(hex(randomblob(16))), 'Fees vs Value',
   'Whether the benefits justify the fee', 5);
