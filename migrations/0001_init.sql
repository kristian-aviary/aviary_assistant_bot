create table conversation_reference (
  user_id          text primary key,
  tenant_id        text not null,
  aad_object_id    text not null,
  conversation_id  text not null,
  service_url      text not null,
  reference        jsonb not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index conversation_reference_tenant_aad_uidx
  on conversation_reference (tenant_id, aad_object_id);

create table send_idempotency (
  key          uuid primary key,
  user_id      text not null,
  status       text not null check (status in ('in_progress', 'sent', 'failed_permanent', 'unknown')),
  outcome      text check (outcome in ('blocked_or_uninstalled', 'invalid_request')),
  activity_id  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (status <> 'failed_permanent' or outcome is not null)
);

create index send_idempotency_created_at_idx on send_idempotency (created_at);
