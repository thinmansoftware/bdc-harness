-- Rebuild-scoped drain clears itself on the next boot. Incident freezes
-- leave clear_on_boot at 0 and survive a container recreate.

ALTER TABLE remote_agent_cauldron_control
  ADD COLUMN clear_on_boot INTEGER NOT NULL DEFAULT 0;
