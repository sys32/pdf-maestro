"""Builds index.html: a single offline file with all libraries and fonts embedded.
Usage: npm install && python3 tools/build_standalone.py
"""
import base64, re
import os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B=os.path.join(ROOT,'node_modules')+'/'
src=open(os.path.join(ROOT,'src','app.html')).read()
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
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>','<script>'+esc(rd('jszip/dist/jszip.min.js'))+'</script>')
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>',
    '<script>'+esc(rd('pdfjs-dist/build/pdf.min.js'))+'</script>\n<script type="text/plain" id="pdf-worker-src">'+esc(rd('pdfjs-dist/build/pdf.worker.min.js'))+'</script>')
rep('''    const ws = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    try{ pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob(['importScripts("'+ws+'");'],{type:'text/javascript'})); }
    catch(e){ pdfjsLib.GlobalWorkerOptions.workerSrc = ws; }''',
'''    try{ pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([document.getElementById('pdf-worker-src').textContent],{type:'text/javascript'})); }
    catch(e){ pdfjsOK = false; }''')
assert 'https://' not in re.sub(r'<script>[\s\S]*?</script>|<script type="text/plain"[\s\S]*?</script>','',src), 'external URL left'
csp="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
i=src.index('<div class="wrap">')
out=('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'
 '<meta http-equiv="Content-Security-Policy" content="'+csp+'">\n'
 '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
 '<style>body{margin:0}[hidden]{display:none!important}</style>\n'
 +src[:i]+'</head><body>\n'+src[i:]+'\n</body></html>\n')
open(os.path.join(ROOT,'index.html'),'w').write(out)
print(len(out)//1024,'KB')
