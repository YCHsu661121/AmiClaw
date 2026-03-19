import sqlite3, json, ctypes, os, base64

db_path = os.path.expandvars(r'%APPDATA%\Code\User\globalStorage\state.vscdb')
local_state_path = os.path.expandvars(r'%APPDATA%\Code\Local State')

# --- Step 1: Get master key from Local State ---
with open(local_state_path, 'r', encoding='utf-8') as f:
    local_state = json.load(f)

encrypted_key_b64 = local_state.get('os_crypt', {}).get('encrypted_key', '')
if not encrypted_key_b64:
    print('No os_crypt.encrypted_key found in Local State')
    exit(1)

encrypted_key = base64.b64decode(encrypted_key_b64)
# Strip "DPAPI" prefix (5 bytes)
print(f'encrypted_key prefix: {encrypted_key[:5]}')
dpapi_blob = encrypted_key[5:]

class DATA_BLOB(ctypes.Structure):
    _fields_ = [('cbData', ctypes.c_ulong), ('pbData', ctypes.POINTER(ctypes.c_char))]

in_data = (ctypes.c_char * len(dpapi_blob))(*dpapi_blob)
in_blob = DATA_BLOB(len(dpapi_blob), in_data)
out_blob = DATA_BLOB()

ok = ctypes.windll.crypt32.CryptUnprotectData(
    ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
)
if not ok:
    err = ctypes.windll.kernel32.GetLastError()
    print(f'DPAPI master key decrypt failed, error={err}')
    exit(1)

master_key = ctypes.string_at(out_blob.pbData, out_blob.cbData)
ctypes.windll.kernel32.LocalFree(out_blob.pbData)
print(f'Master key length: {len(master_key)}')

# --- Step 2: Decrypt vscdb value with AES-256-GCM ---
from Crypto.Cipher import AES

def decrypt_v10(buf, key):
    # v10 format: "v10" (3) + nonce (12) + ciphertext + tag(16)
    nonce = buf[3:15]
    ciphertext_with_tag = buf[15:]
    ciphertext = ciphertext_with_tag[:-16]
    tag = ciphertext_with_tag[-16:]
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    return cipher.decrypt_and_verify(ciphertext, tag)

# Read jiraSites from DB
c = sqlite3.connect(db_path)

state_row = c.execute('SELECT value FROM ItemTable WHERE key=?', ['atlassian.atlascode']).fetchone()
if state_row:
    state = json.loads(state_row[0])
    sites = state.get('jiraSites', [])
    print('jiraSites:')
    for s in sites:
        print(f"  host={s.get('host')}, baseApiUrl={s.get('baseApiUrl')}, credentialId={s.get('credentialId')}")
        cred_key = 'secret://{"extensionId":"atlassian.atlascode","key":"jira-' + s['credentialId'] + '"}'
        row = c.execute('SELECT value FROM ItemTable WHERE key=?', [cred_key]).fetchone()
        if row:
            data = json.loads(row[0])
            buf = bytes(data['data'])
            print(f'  buf prefix: {buf[:3]}, len={len(buf)}')
            try:
                plaintext = decrypt_v10(buf, master_key)
                print(f'  Decrypted: {plaintext.decode("utf-8")[:300]}')
            except Exception as e:
                print(f'  AES-GCM decrypt failed: {e}')
        else:
            print(f'  No credential row for key: {cred_key}')

cred_key = 'secret://{"extensionId":"atlassian.atlascode","key":"jira-89de22f89f2231c932f685eb54b23bdc"}'
row = c.execute('SELECT value FROM ItemTable WHERE key=?', [cred_key]).fetchone()
if row:
    data = json.loads(row[0])
    buf = bytes(data['data'])
    print(f'\nRaw bytes prefix: {buf[:3]}')
    print(f'Total length: {len(buf)}')
    
    class DATA_BLOB(ctypes.Structure):
        _fields_ = [('cbData', ctypes.c_ulong), ('pbData', ctypes.POINTER(ctypes.c_char))]
    
    def try_dpapi(enc):
        in_data = (ctypes.c_char * len(enc))(*enc)
        in_blob = DATA_BLOB(len(enc), in_data)
        out_blob = DATA_BLOB()
        ok = ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
        )
        if ok and out_blob.cbData > 0:
            plain = ctypes.string_at(out_blob.pbData, out_blob.cbData)
            ctypes.windll.kernel32.LocalFree(out_blob.pbData)
            return plain
        err = ctypes.windll.kernel32.GetLastError()
        print(f'  DPAPI failed, error={err}')
        return None

    # Try without "v10" prefix
    print('Trying without v10 prefix...')
    result = try_dpapi(buf[3:])
    if not result:
        # Try with full buffer
        print('Trying full buffer...')
        result = try_dpapi(buf)
    if not result:
        # Try raw DPAPI with different offset
        print('Trying offset 0...')
        result = try_dpapi(buf)
    
    if result:
        print(f'Decrypted ({len(result)} bytes): {result[:500]}')
    else:
        print('All decrypt attempts failed')
else:
    print('Credential not found in DB')

c.close()
