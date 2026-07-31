import json
import os
import sys

from curl_cffi import requests


IMPERSONATE_DEFAULT = 'edge99'
IMPERSONATE_FALLBACK = 'chrome131'


def header_value(headers, wanted):
    wanted = wanted.lower()
    for key, value in headers.items():
        if str(key).lower() == wanted:
            return str(value or '')
    return ''


req = json.load(sys.stdin)

proxy = (
    (req.get('proxy') or '').strip()
    or os.environ.get('CF_PROXY', '').strip()
    or os.environ.get('HTTPS_PROXY', '').strip()
    or os.environ.get('https_proxy', '').strip()
)
proxies = {'http': proxy, 'https': proxy} if proxy else None

headers = dict(req.get('headers') or {})
if req.get('token'):
    headers['Authorization'] = 'Bearer ' + req['token']
headers.setdefault('Content-Type', 'application/json')


def do_request(impersonate):
    return requests.request(
        req.get('method', 'GET'),
        req['url'],
        headers=headers,
        json=req.get('body'),
        impersonate=impersonate,
        proxies=proxies,
        timeout=30,
    )


# 请求可指定 TLS 指纹（指纹库按任务分配）；不支持或异常时回落 chrome131
requested = (req.get('impersonate') or '').strip() or IMPERSONATE_DEFAULT
try:
    r = do_request(requested)
    IMPERSONATE = requested
except Exception:
    r = do_request(IMPERSONATE_FALLBACK)
    IMPERSONATE = IMPERSONATE_FALLBACK

content_type = header_value(r.headers, 'content-type')
cf_mitigated = header_value(r.headers, 'cf-mitigated')

try:
    body = r.json()
except Exception:
    body = {'raw': r.text[:300]}

out = {
    'status': r.status_code,
    'json': body,
    'headers': {
        'contentType': content_type,
        'cfMitigated': cf_mitigated,
    },
    'impersonate': IMPERSONATE,
}

header_challenge = cf_mitigated.strip().lower() == 'challenge'
html_candidate = (
    r.status_code in (403, 429, 503)
    and 'text/html' in content_type.lower()
)
if header_challenge or html_candidate:
    out['html'] = r.text

print(json.dumps(out))
