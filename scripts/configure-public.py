#!/usr/bin/env python3
"""One-time public endpoint wiring, with no credentials or project creation."""
import argparse,json,pathlib
from urllib.parse import urlparse
p=argparse.ArgumentParser();p.add_argument('--api-base',required=True);p.add_argument('--website',type=pathlib.Path,required=True);a=p.parse_args()
u=urlparse(a.api_base)
if u.scheme!='https' or not u.netloc or u.query or u.fragment or not u.path.endswith('/functions/v1/gptyar-api'):p.error('Use the actual HTTPS Supabase /functions/v1/gptyar-api URL')
root=pathlib.Path(__file__).resolve().parents[1]
for target,variable in [(root/'config.js','ADMIN_PANEL_CONFIG'),(a.website/'commerce-config.js','GPTYAR_COMMERCE_CONFIG')]:
 target.write_text('// Public endpoint only. No secrets.\nwindow.'+variable+' = Object.freeze('+json.dumps({'API_BASE_URL':a.api_base.rstrip('/')})+');\n')
print('Public endpoint configured for panel and website. No service credentials were written.')
