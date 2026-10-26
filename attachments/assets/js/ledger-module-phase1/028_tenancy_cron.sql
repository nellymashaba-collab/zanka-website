-- 028_tenancy_cron.sql
-- Runs the tenancy-automation Edge Function once a day at 05:15 SAST
-- (03:15 UTC): lease-expiry notices, month-to-month rollovers, rent
-- escalations, arrears reminders, deadline alerts and viewing reminders.
-- Run AFTER 027_tenancy_lifecycle.sql and after deploying the function.
-- Uses the public anon key (the same one the website uses); the "daily"
-- action is idempotent, so a repeat run sends nothing twice.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'tenancy-automation-daily';

select cron.schedule(
  'tenancy-automation-daily',
  '15 3 * * *',
  $$
  select net.http_post(
    url := 'https://blhjlsddmwxjchjlfnhk.supabase.co/functions/v1/tenancy-automation',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsaGpsc2RkbXd4amNoamxmbmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMDkwMjcsImV4cCI6MjA5OTg4NTAyN30.Qrax77f9M1Ov7ycft-PYvzEUstVqe-c0ExOoeRO_DbM',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsaGpsc2RkbXd4amNoamxmbmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMDkwMjcsImV4cCI6MjA5OTg4NTAyN30.Qrax77f9M1Ov7ycft-PYvzEUstVqe-c0ExOoeRO_DbM'),
    body := '{"action":"daily"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Check it: select * from cron.job where jobname = 'tenancy-automation-daily';
-- Recent runs: select * from cron.job_run_details order by start_time desc limit 5;
