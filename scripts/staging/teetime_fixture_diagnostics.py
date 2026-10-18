"""Bounded synthetic SDK diagnostic framing; phases never grant success."""
import base64
import json

from teetime_artifact_contract import unique_object, reject_constant

PHASES = ('logger', 'resolve', 'real-import', 'policy-options', 'mock-install',
          'import-verify', 'factory-import', 'factory-construct', 'collect', 'complete')
FINAL_KEYS = {'kind', 'accepted', 'bytesBase64', 'intercepted', 'threads', 'optionsVerified',
    'threadOptionsVerified', 'importIntercepted', 'normalProviderEnd', 'counts',
    'abortedBeforeCleanup', 'phase', 'errorName', 'errorCode'}
BOOLEAN_KEYS = ('accepted', 'optionsVerified', 'threadOptionsVerified', 'importIntercepted',
                'normalProviderEnd', 'abortedBeforeCleanup')
CHUNK_TYPES = {'assistant', 'result', 'thinking', 'error', 'system', 'tool_use', 'tool_result',
               'rate_limit', 'routing', 'warning'}


class DiagnosticProtocol:
    phases = PHASES

    def __init__(self):
        self.buffer = bytearray()
        self.total = 0
        self.index = 0
        self.final = None

    @property
    def last_phase(self):
        return self.phases[self.index-1] if self.index else None

    def feed(self, chunk):
        if type(chunk) is not bytes or self.total+len(chunk) > 32768:
            raise ValueError('diagnostic byte bound')
        self.total += len(chunk)
        self.buffer.extend(chunk)
        while b'\n' in self.buffer:
            line, _, rest = self.buffer.partition(b'\n')
            self.buffer = bytearray(rest)
            if not line.isascii():
                raise ValueError('ASCII diagnostic records required')
            if self.final is not None:
                raise ValueError('post-final diagnostic data')
            try:
                value = json.loads(line, object_pairs_hook=unique_object, parse_constant=reject_constant)
            except (ValueError, UnicodeError, RecursionError):
                raise ValueError('invalid diagnostic framing') from None
            if type(value) is not dict:
                raise ValueError('diagnostic object required')
            if value.get('kind') == 'phase':
                if (set(value) != {'kind', 'phase'} or self.index >= len(self.phases)
                        or value['phase'] != self.phases[self.index]):
                    raise ValueError('diagnostic phase order or fields')
                self.index += 1
            else:
                self.check_final(value)
                self.final = value

    def check_final(self, value):
        if set(value) != FINAL_KEYS or value['kind'] != 'result' or self.index == 0:
            raise ValueError('diagnostic final fields')
        if value['phase'] != self.last_phase or any(type(value[key]) is not bool for key in BOOLEAN_KEYS):
            raise ValueError('diagnostic final phase or boolean')
        if any(type(value[key]) is not int or not 0 <= value[key] <= 1 for key in ['intercepted', 'threads']):
            raise ValueError('diagnostic constructor counts')
        if value['errorName'] not in [None, 'Error', 'TypeError', 'SyntaxError', 'ResolveMessage', 'other']:
            raise ValueError('diagnostic error category')
        if value['errorCode'] not in [None, 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']:
            raise ValueError('diagnostic error code')
        counts = value['counts']
        if (type(counts) is not dict or not set(counts).issubset(CHUNK_TYPES)
                or any(type(count) is not int or not 0 <= count <= 64 for count in counts.values())):
            raise ValueError('diagnostic chunk counts')
        encoded = value['bytesBase64']
        if value['accepted']:
            if (value['phase'] != 'complete' or value['errorName'] is not None or value['errorCode'] is not None
                    or not value['normalProviderEnd'] or value['abortedBeforeCleanup']):
                raise ValueError('contradictory accepted diagnostic result')
            if type(encoded) is not str or len(encoded) > 32768:
                raise ValueError('diagnostic artifact encoding')
            try:
                data = base64.b64decode(encoded, validate=True)
            except ValueError:
                raise ValueError('diagnostic artifact base64') from None
            if base64.b64encode(data).decode('ascii') != encoded:
                raise ValueError('diagnostic artifact canonical base64')
        elif encoded is not None:
            raise ValueError('rejected artifact bytes prohibited')

    def finish(self, exit_code):
        if type(exit_code) is not int or exit_code != 0:
            raise ValueError('normal process exit required')
        if self.buffer or self.final is None:
            raise ValueError('incomplete diagnostic protocol')
        return self.final


class ImportDiagnosticProtocol(DiagnosticProtocol):
    phases = PHASES[:7]

    def check_final(self, value):
        keys = {'kind', 'phase', 'importOnlySuccess', 'exportsVerified', 'moduleIntercepted',
                'factoryImported', 'errorName', 'errorCode'}
        if set(value) != keys or value['kind'] != 'import-only-result' or self.index == 0:
            raise ValueError('import-only final fields')
        if value['phase'] != self.last_phase:
            raise ValueError('import-only phase mismatch')
        checks = ['importOnlySuccess', 'exportsVerified', 'moduleIntercepted', 'factoryImported']
        if any(type(value[key]) is not bool for key in checks):
            raise ValueError('import-only boolean required')
        if value['errorName'] not in [None, 'Error', 'TypeError', 'SyntaxError', 'ResolveMessage', 'other']:
            raise ValueError('import-only error category')
        if value['errorCode'] not in [None, 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']:
            raise ValueError('import-only error code')
        if value['importOnlySuccess'] and (self.last_phase != 'factory-import'
                or not all(value[key] for key in checks) or value['errorName'] is not None
                or value['errorCode'] is not None):
            raise ValueError('contradictory import-only result')
