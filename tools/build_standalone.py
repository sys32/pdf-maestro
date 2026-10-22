"""Builds index.html: PDF Maestro with the text editor, as one offline file with every library and font embedded.
Sources: src/app.html (PDF Maestro), src/editor/app.html + src/editor/engine.js (the text editor).
Usage: npm install && npm run build
"""
import os, re, base64
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NM = B = os.path.join(ROOT, 'node_modules') + '/'
b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()
rd = lambda p: open(B + p).read()

# ---- 1. put the editor inside PDF Maestro
esc = lambda s: s.replace('</script', '<\\/script')
b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()

main = open(os.path.join(ROOT, 'src', 'app.html')).read()
app = open(os.path.join(ROOT, 'src', 'editor', 'app.html')).read()
engine = open(os.path.join(ROOT, 'src', 'editor', 'engine.js')).read()

# ---------------------------------------------------------------- editor parts
css = app[app.index('<style>') + 7: app.index('</style>')]
css = re.sub(r'/\*[\s\S]*?\*/', '', css)
ws_a = app.index('<section class="ws" id="ws" hidden>')
ws_b = app.index('</section>', app.index('<aside class="card side">', ws_a)) + len('</section>')
ws = app[ws_a:ws_b]
tip = '<div class="tip" id="tip" hidden></div>'
js_a = app.index('<script>\n(function(){')
js = app[js_a + len('<script>'): app.index('</script>', js_a)]
js = js.replace("'%%FONT_REG%%'", "'" + b64(NM + '@expo-google-fonts/inter/Inter_400Regular.ttf') + "'", 1)
js = js.replace("'%%FONT_BOLD%%'", "'" + b64(NM + '@expo-google-fonts/inter/Inter_700Bold.ttf') + "'", 1)
assert '%%' not in js

PRE = '.el-root'
def map_sel(sel):
    sel = sel.strip()
    if sel == ':root': return PRE
    if sel.startswith(':root:not([data-theme="light"])'): return ':root:not([data-theme="light"]) ' + PRE
    if sel.startswith(':root[data-theme="dark"]'): return ':root[data-theme="dark"] ' + PRE
    if sel == 'body': return PRE
    if sel == '*': return PRE + ' *'
    return PRE + ' ' + sel
def scope(text):
    out, i, n = [], 0, len(text)
    while i < n:
        j = text.find('{', i)
        if j < 0: break
        head = text[i:j].strip()
        # matching brace
        depth, k = 0, j
        while k < n:
            if text[k] == '{': depth += 1
            elif text[k] == '}':
                depth -= 1
                if depth == 0: break
            k += 1
        body = text[j + 1:k]
        if head.startswith('@media') or head.startswith('@supports'):
            out.append(head + '{' + scope(body) + '}')
        elif head.startswith('@keyframes'):
            out.append(head.replace('@keyframes sp', '@keyframes el-sp') + '{' + body + '}')
        elif head:
            out.append(','.join(map_sel(s) for s in head.split(',')) + '{' + body + '}')
        i = k + 1
    return '\n'.join(out)
scoped = scope(css).replace('animation:sp ', 'animation:el-sp ')

shell_css = '''
.el-root{position:fixed;inset:0;z-index:35;background:var(--bg);color:var(--fg);overflow:auto;overscroll-behavior:contain;font-family:var(--font);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.el-root[hidden],.el-root [hidden]{display:none!important}
.el-root .el-top{position:sticky;top:0;z-index:8;display:flex;align-items:center;gap:12px;padding:10px max(16px,calc((100% - 1320px)/2 + 20px));background:var(--surface);border-bottom:1px solid var(--line)}
.el-root .el-back{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--surface);color:var(--fg);border-radius:9px;padding:7px 12px 7px 9px;font-weight:600;font-size:13px;cursor:pointer}
.el-root .el-back:hover{background:var(--sunken);border-color:var(--line-strong)}
.el-root .el-back svg{width:14px;height:14px}
.el-root .el-title{flex:1;min-width:0;display:grid;line-height:1.3}
.el-root .el-title b{font-size:15px;font-weight:700;letter-spacing:-.01em}
.el-root .el-title small{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.el-root .el-done{width:auto;padding:9px 18px;font-size:13.5px;border-radius:10px}
.el-root .el-body{max-width:1320px;margin:0 auto;padding:18px 20px 48px}
.el-root .side{top:78px}
.el-root #el-other{display:none}
.el-root .chip{border:0}
.el-root .card.bar{height:auto;overflow:visible}
@media (max-width:640px){.el-root .el-title small{display:none}.el-root .el-body{padding:12px 12px 40px}}
'''

BACK = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3 4.5 7l4 4"/></svg>'
CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>'
prefixed = re.sub(r'\bid="([^"]+)"', r'id="el-\1"', ws + '\n' + tip)
markup = ('<div class="el-root" id="el-root" role="dialog" aria-modal="true" aria-labelledby="el-ttl" hidden>\n'
          '  <div class="el-top">\n'
          '    <button class="el-back" id="el-back">' + BACK + '<span data-el="back"></span></button>\n'
          '    <div class="el-title"><b id="el-ttl" data-el="editTitle"></b><small data-el="editHint"></small></div>\n'
          '    <button class="btn el-done" id="el-done">' + CHECK + '<span data-el="done"></span></button>\n'
          '  </div>\n'
          '  <div class="el-body">\n' + prefixed + '\n  </div>\n</div>')

# ---------------------------------------------------------------- compose
src = main
assert src.count('<!--EDITOR_MARKUP-->') == 1
src = src.replace('<!--EDITOR_MARKUP-->', markup, 1)
i = src.index('</style>')
src = src[:i] + '\n/* ---- editor (Edit Lab) ---- */\n' + scoped + shell_css + src[i:]
PDFJS = '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>'
FONTKIT = '<script src="https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js"></script>'
assert src.count(PDFJS) == 1
editor_scripts = (FONTKIT + '\n<script>window.__PM_EMBED = true;</script>\n<script>' + esc(engine) + '</script>\n'
                  '<script>' + esc(js) + '</script>')
# editor scripts go right after the PDF Maestro script so PDF Maestro sets up PDF.js first
last = src.rindex('</script>') + len('</script>')
src = src[:last] + '\n' + editor_scripts + src[last:]

# ---- 2. inline every library and font
def rep(a,b):
    global src
    assert a in src, a[:70]
    src=src.replace(a,b,1)
esc=lambda s: s.replace('</script','<\\/script')
rd=lambda p: open(B+p).read()
# fonts -> embedded
f64=lambda n: base64.b64encode(open(B+'@fontsource-variable/inter/files/inter-'+n+'-wght-normal.woff2','rb').read()).decode()
ranges={'cyrillic':'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
 'latin-ext':'U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
 'latin':'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'}
ff=''.join("@font-face{font-family:'Inter';font-style:normal;font-display:swap;font-weight:100 900;src:url(data:font/woff2;base64,%s) format('woff2');unicode-range:%s}\n"%(f64(k),v) for k,v in ranges.items())
rep('''<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">''','<style>\n'+ff+'</style>')
rep('Processed on this device. Your files are never uploaded.','Works offline. Your files never leave this computer.')
rep('Се обработува на овој уред. Фајловите никогаш не се прикачуваат.','Работи без интернет. Фајловите никогаш не го напуштаат овој компјутер.')
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"></script>','<script>'+esc(rd('pdf-lib/dist/pdf-lib.min.js'))+'</script>')
rep('<script src="https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js"></script>','<script>'+esc(rd('@pdf-lib/fontkit/dist/fontkit.umd.min.js'))+'</script>')
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>','<script>'+esc(rd('jszip/dist/jszip.min.js'))+'</script>')
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>',
    '<script>'+esc(rd('pdfjs-dist/build/pdf.min.js'))+'</script>\n<script type="text/plain" id="pdf-worker-src">'+esc(rd('pdfjs-dist/build/pdf.worker.min.js'))+'</script>')
rep('''    const ws = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    try{ pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob(['importScripts("'+ws+'");'],{type:'text/javascript'})); }
    catch(e){ pdfjsLib.GlobalWorkerOptions.workerSrc = ws; }''',
'''    try{ const _wc = document.getElementById('pdf-worker-src').textContent; if(location.protocol==='file:'){ pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([_wc],{type:'text/javascript'})); } else { const _s = document.createElement('script'); _s.textContent = '(function(exports, module, define){' + _wc + '\\n})();'; document.head.appendChild(_s); } }catch(e){ pdfjsOK = false; }''')
assert 'https://' not in re.sub(r'<script>[\s\S]*?</script>|<script type="text/plain"[\s\S]*?</script>','',src), 'external URL left'
csp="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
i=src.index('<div class="wrap">')
out=('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'
 '<meta http-equiv="Content-Security-Policy" content="'+csp+'">\n'
 '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
 '<style>body{margin:0}[hidden]{display:none!important}</style>\n'
 +src[:i]+'</head><body>\n'+src[i:]+'\n</body></html>\n')
open(os.path.join(ROOT, 'index.html'), 'w').write(out)
print(len(out)//1024,'KB')
