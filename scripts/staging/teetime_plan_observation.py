"""Read-only PC GitHub observation for the single supervised demo carrier.

No credentials leave this process. No evidence-file import or review submission.
The remote claim entry must bind this ephemeral observation to its actual state.
"""
import base64
import hashlib
import json
import os
import re
import time

from teetime_bounded_process import capture
from teetime_demo_execution import parse_demo_execution
from teetime_joined_fixture import strict_json

REPOSITORY = 'thinmansoftware/bdc-xo'
PLAN_PR = 3392
PACKAGE_PATH = 'docs/tee-time/supervised-demo-execution.json'
APP_STAGING_ENDPOINT = 'repos/thinmansoftware/whats-that-tee-time/git/ref/heads/staging'
APP_BASE_SHA = 'bf6e8935768cf39ebb56b3ef44535830fd71ea7f'
GH = r'C:\Program Files\GitHub CLI\gh.exe'


def github_read(endpoint):
    if (not endpoint.startswith('repos/'+REPOSITORY+'/') and endpoint != APP_STAGING_ENDPOINT) or '\n' in endpoint:
        raise ValueError('closed GitHub read target required')
    env = dict(os.environ)
    env['GH_HOST'] = 'github.com'
    code, raw = capture([GH, 'api', '--method', 'GET', endpoint], 20,
                        limit=2*1024*1024, env=env)
    if code != 0:
        raise ValueError('GitHub read failed')
    return strict_json(raw)


def observe_plan(execution_raw, execution_hash, expected_head, nonce, *, read=github_read, clock=time.time):
    execution = parse_demo_execution(execution_raw, execution_hash)
    if re.fullmatch('[a-f0-9]{40}', expected_head or '') is None or re.fullmatch('[a-f0-9]{32}', nonce or '') is None:
        raise ValueError('exact plan head and fresh invocation nonce required')
    began = clock()
    endpoint = 'repos/'+REPOSITORY+'/pulls/'+str(PLAN_PR)
    pull = read(endpoint)
    def validate_pull(value):
        if (type(value) is not dict or value.get('number') != PLAN_PR or value.get('state') != 'open'
                or value.get('merged_at') is not None
                or value.get('head',{}).get('sha') != expected_head
                or value.get('head',{}).get('repo',{}).get('full_name') != REPOSITORY
                or value.get('base',{}).get('repo',{}).get('full_name') != REPOSITORY
                or value.get('base',{}).get('repo',{}).get('private') is not True):
            raise ValueError('current private plan carrier differs')
        author = value.get('user',{}).get('login')
        if type(author) is not str or not author or author.lower() == 'thinman-overseer[bot]':
            raise ValueError('independent carrier author required')
        return author
    author = validate_pull(pull)
    contents = read('repos/'+REPOSITORY+'/contents/'+PACKAGE_PATH+'?ref='+expected_head)
    if (type(contents) is not dict or contents.get('type') != 'file' or contents.get('path') != PACKAGE_PATH
            or contents.get('encoding') != 'base64' or type(contents.get('content')) is not str
            or contents.get('size') != len(execution_raw)):
        raise ValueError('complete exact-head execution file required')
    try:
        published = base64.b64decode(contents['content'].replace('\n',''), validate=True)
    except ValueError:
        raise ValueError('GitHub file encoding rejected') from None
    if published != execution_raw or hashlib.sha256(published).hexdigest() != execution_hash:
        raise ValueError('reviewed package differs from execution bytes')
    reviews = []
    for page in range(1, 21):
        batch = read(endpoint+'/reviews?per_page=100&page='+str(page))
        if type(batch) is not list or len(batch)>100:
            raise ValueError('complete bounded review pages required')
        for item in batch:
            if type(item) is not dict: raise ValueError('review record rejected')
            # Unsubmitted reviews convey no approval. Do not invent a timestamp.
            if item.get('state') == 'PENDING': continue
            reviews.append({'id':item.get('id'), 'login':item.get('user',{}).get('login'),
                'state':item.get('state'), 'head':item.get('commit_id'), 'submittedAt':item.get('submitted_at')})
        if len(batch)<100: break
    else:
        raise ValueError('review pagination incomplete')
    if validate_pull(read(endpoint)) != author:
        raise ValueError('plan author changed during observation')
    staging = read(APP_STAGING_ENDPOINT)
    if (type(staging) is not dict or staging.get('ref') != 'refs/heads/staging'
            or staging.get('object',{}).get('sha') != APP_BASE_SHA
            or staging.get('object',{}).get('type') != 'commit'):
        raise ValueError('actual remote app staging changed')
    now = clock()
    if not 0 <= now-began <= 45:
        raise ValueError('plan observation exceeded fresh-read window')
    packet = {'version':1, 'kind':'tee-time-plan-observation', 'remote':'bdc-server',
        'nonce':nonce, 'remoteStagingSha':APP_BASE_SHA, 'observedAtMs':int(now*1000), 'expiresAtMs':int(now*1000)+60000,
        'executionHash':'sha256:'+execution_hash, 'preparedBindingHash':execution.prepared_binding_hash,
        'runId':execution.binding['runId'], 'repository':REPOSITORY, 'pullRequest':PLAN_PR,
        'packagePath':PACKAGE_PATH,
        'review':{'head':expected_head,'state':'OPEN','author':author,'complete':True,'reviews':reviews}}
    raw = json.dumps(packet,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')
    if len(raw)>65536: raise ValueError('bounded plan observation exceeded')
    return raw
