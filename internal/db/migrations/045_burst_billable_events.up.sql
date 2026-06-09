ALTER TABLE billable_events
  DROP CONSTRAINT IF EXISTS billable_events_event_type_check;

ALTER TABLE billable_events
  ADD CONSTRAINT billable_events_event_type_check
  CHECK (event_type IN ('reserved_usage', 'overage_usage', 'burst_usage', 'disk_overage_usage'));
