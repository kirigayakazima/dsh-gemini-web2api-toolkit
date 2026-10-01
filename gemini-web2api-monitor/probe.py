"""gemini-web2api-monitor 探测脚本（由插件定时调用）。
复用 Python urllib 通道（已验证对本机 Clash 代理 100% 可通），
发一个 StreamGenerate 诊断请求，解析上游权威字段 slot39/slot42，
输出 JSON 到 stdout，供插件读取。

用法:
  python probe.py --gemini-dir D:/CodePackage/DSP/gemini-web2api \
                  --model-id 56fdd199312815e2 \
                  --proxy http://127.0.0.1:7890
"""
import sys, json, time, uuid, urllib.request, urllib.parse, ssl, re, hashlib, importlib.util, os, argparse

# 关键：强制 stdout 用 UTF-8（Windows 下被管道捕获时默认是 gbk，会造成 Node 侧乱码）
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

REJECT_ID = 'cf41b0e0dd7d53e5'
TS_COOKIE = '__Secure-1PSIDTS'

ap = argparse.ArgumentParser()
ap.add_argument('--gemini-dir', default='D:/CodePackage/DSP/gemini-web2api')
ap.add_argument('--model-id', default='56fdd199312815e2')
ap.add_argument('--proxy', default='http://127.0.0.1:7890')
args = ap.parse_args()

GEMINI_DIR = args.gemini_dir
MODEL_ID = args.model_id
PROXY = args.proxy

def out(obj):
    # ensure_ascii=True：中文转 \uXXXX，纯 ASCII 输出，彻底免疫编码问题
    print(json.dumps(obj, ensure_ascii=True))

try:
    # 复用单文件 gemini_web2api.py 的认证逻辑
    spec = importlib.util.spec_from_file_location('gw', os.path.join(GEMINI_DIR, 'gemini_web2api.py'))
    gw = importlib.util.module_from_spec(spec)
    sys.modules['gw'] = gw
    spec.loader.exec_module(gw)
    CONFIG = gw.CONFIG
    with open(os.path.join(GEMINI_DIR, 'config.json')) as f:
        CONFIG.update(json.load(f))
    CONFIG['proxy'] = PROXY

    cookie_str, sapisid = gw.load_cookie()
    if not cookie_str:
        out({'ok': None, 'error': '读取 gemini 认证文件失败', 'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
        sys.exit(0)

    xsrf = CONFIG.get('xsrf_token') or ''
    # 认证文件里的 xsrf_token 常为空 → 缺 at= 参数会被上游判 400（表现为"探测异常 400"），
    # 因此这里自己从登录态页面抓一次 SNlM0e。注意不能用 FdrFJe：那只是会话 ID（纯数字），
    # 当 at= 发出去会得到 [["er",...,400,...,[{"..":["xsrf",...]}]]]。
    if not xsrf:
        try:
            _req = urllib.request.Request(
                'https://gemini.google.com/app',
                headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                         'Cookie': cookie_str})
            _op = urllib.request.build_opener(
                urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY}),
                urllib.request.HTTPSHandler(context=ssl.create_default_context()))
            _html = _op.open(_req, timeout=20).read().decode('utf-8', errors='replace')
            _m = re.search(r'"SNlM0e"\s*:\s*"([A-Za-z0-9_\-]+:\d{8,})"', _html)
            if _m:
                xsrf = _m.group(1)
        except Exception:
            xsrf = ''
    bl = CONFIG['gemini_bl']
    has_ts = TS_COOKIE + '=' in cookie_str

    inner = [None] * 80
    inner[0] = ['ping', 0, None, None, None, None, 0]
    inner[1] = ['en']
    inner[2] = ['', '', '', None, None, None, None, None, None, '']
    inner[6] = [0]; inner[7] = 1; inner[10] = 1; inner[11] = 0
    inner[17] = [[4]]
    inner[18] = 0; inner[27] = 1; inner[30] = [4]
    inner[41] = [1]; inner[45] = 1
    inner[53] = 0; inner[59] = str(uuid.uuid4()); inner[61] = []; inner[68] = 1
    inner[79] = 1

    params = {'f.req': json.dumps([None, json.dumps(inner)])}
    if xsrf:
        params['at'] = xsrf
    body = urllib.parse.urlencode(params).encode()
    reqid = int(time.time()) % 1000000
    url = (f"https://gemini.google.com/_/BardChatUi/data/"
           f"assistant.lamda.BardFrontendService/StreamGenerate"
           f"?bl={bl}&hl=en&_reqid={reqid}&rt=c")
    headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://gemini.google.com',
        'Referer': 'https://gemini.google.com/app',
        'X-Same-Domain': '1',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookie_str,
    }
    if sapisid:
        ts = int(time.time())
        h = hashlib.sha1(f"{ts} {sapisid} https://gemini.google.com".encode()).hexdigest()
        headers['Authorization'] = f'SAPISIDHASH {ts}_{h}'
    headers['x-goog-ext-525001261-jspb'] = json.dumps(
        [1, None, None, None, MODEL_ID, None, None, 0,
         [4, 5, 6, 8, 4, 5, 6, 8], None, None, 2,
         None, None, 1, 0, str(uuid.uuid4())], separators=(',', ':'))
    # 若模块提供了 build_model_header（与反代完全一致的模型选择头），优先复用，
    # 确保探测结果与真实请求行为一致（避免简化 header 触发 Google 降级保护）。
    try:
        hdr = gw.build_model_header('gemini-3.8-flash', 1)
        if hdr:
            headers['x-goog-ext-525001261-jspb'] = hdr
    except Exception:
        pass

    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    ctx = ssl.create_default_context()
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY}),
        urllib.request.HTTPSHandler(context=ctx))
    t0 = time.time()
    resp = opener.open(req, timeout=45)
    raw = resp.read().decode('utf-8', errors='replace')
    latency = int((time.time() - t0) * 1000)

    slot39, slot42 = None, None
    for line in raw.split('\n'):
        if '"wrb.fr"' not in line:
            continue
        try:
            arr = json.loads(line)
            inner2 = json.loads(arr[0][2])
            if isinstance(inner2, list):
                if len(inner2) > 42 and inner2[42]:
                    slot42 = str(inner2[42])
                if len(inner2) > 39 and inner2[39]:
                    slot39 = str(inner2[39])
        except Exception:
            pass
    ok = slot39 == MODEL_ID
    out({
        'ok': ok,
        'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'slot39': slot39,
        'modelLabel': slot42,
        'expectedId': MODEL_ID,
        'latencyMs': latency,
        'cookieHasTs': has_ts,
        'error': None if ok else (f'实际路由 {slot42 or "未知"}（{slot39}），已降级' if slot39 else '未读到 slot39'),
    })
except Exception as e:
    out({'ok': False, 'error': '探测异常: ' + str(e)[:150], 'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
