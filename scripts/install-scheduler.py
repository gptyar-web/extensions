#!/usr/bin/env python3
"""Initial infrastructure setup only. Uses a Supabase PAT in memory; secrets go to Vault, not source or argv."""
import getpass,json,os,re,urllib.request,pathlib
ref=input('GPT Yar Supabase project ref: ').strip()
if not re.fullmatch(r'[a-z0-9]{20}',ref):raise SystemExit('Invalid project ref')
pat=getpass.getpass('Supabase access token (not saved): ')
worker=getpass.getpass('GPTYAR_WORKER_SECRET (same as Edge Function secret): ')
if len(worker)<32:raise SystemExit('Worker secret must contain at least 32 characters')
base='https://'+ref+'.supabase.co/functions/v1/gptyar-api'
def literal(s):return "'"+s.replace("'","''")+"'"
query="""
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;
do $setup$ declare sid uuid;begin
select id into sid from vault.secrets where name='gptyar_api_base';
if sid is null then perform vault.create_secret(API_BASE,'gptyar_api_base');else perform vault.update_secret(sid,API_BASE);end if;
select id into sid from vault.secrets where name='gptyar_worker_secret';
if sid is null then perform vault.create_secret(WORKER_SECRET,'gptyar_worker_secret');else perform vault.update_secret(sid,WORKER_SECRET);end if;
end $setup$;
select cron.schedule('gptyar-commerce-worker','* * * * *',$job$
select net.http_post(
 url:=(select decrypted_secret from vault.decrypted_secrets where name='gptyar_api_base')||'/jobs/run',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='gptyar_worker_secret')),
 body:='{}'::jsonb,timeout_milliseconds:=60000);
$job$);
select cron.schedule('gptyar-housekeeping','17 2 * * *','select public.gy_housekeeping()');
""".replace('API_BASE',literal(base)).replace('WORKER_SECRET',literal(worker))
req=urllib.request.Request('https://api.supabase.com/v1/projects/'+ref+'/database/query',data=json.dumps({'query':query}).encode(),headers={'Authorization':'Bearer '+pat,'Content-Type':'application/json'},method='POST')
try:
 with urllib.request.urlopen(req,timeout=60) as r:json.loads(r.read())
except Exception as e:raise SystemExit('Scheduler setup failed: '+type(e).__name__+'. No secret value has been printed.')
print('Worker scheduled every minute; housekeeping daily. Verify Cron and net response status in Supabase once.')
