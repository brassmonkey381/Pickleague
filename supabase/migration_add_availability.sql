-- Weekly availability grid: 7 days × 48 half-hour slots = 336 cells
-- Index: dayIndex * 48 + slotIndex
-- dayIndex: 0=Mon, 1=Tue, ..., 6=Sun
-- slotIndex: 0=12:00am, 1=12:30am, ..., 47=11:30pm
alter table public.profiles
  add column if not exists availability boolean[] not null
    default array_fill(false, array[336]);
