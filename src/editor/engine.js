/* PDF Maestro edit engine.
   Finds real text in a page's content stream, groups it into lines, and rewrites
   those lines in place. If every character of the new text exists in the original
   embedded font, the original font is reused (exact match). Otherwise the old text
   is removed and the new text is drawn with a fallback font.
   Works with pdf-lib (PDFLib global in the browser, require('pdf-lib') in Node). */
(function(root){
  'use strict';
  const L = (typeof PDFLib !== 'undefined') ? PDFLib : require('pdf-lib');
  const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRef, decodePDFRawStream, rgb, cmyk, grayscale, StandardFonts, PDFTextField, PDFCheckBox, PDFDropdown } = L;
  const fieldKind = f => (f instanceof PDFTextField) ? 'text' : (f instanceof PDFCheckBox) ? 'check' : (f instanceof PDFDropdown) ? 'select' : null;

  /* ------------------------------------------------------------------ bytes */
  const isWS = c => c===0x20||c===0x0a||c===0x0d||c===0x09||c===0x0c||c===0x00;
  const isDelim = c => c===0x28||c===0x29||c===0x3c||c===0x3e||c===0x5b||c===0x5d||c===0x7b||c===0x7d||c===0x2f||c===0x25;
  const latin1 = b => { let s=''; for(let i=0;i<b.length;i+=8192) s += String.fromCharCode.apply(null, b.subarray(i, i+8192)); return s; };
  const toBytes = s => { const b = new Uint8Array(s.length); for(let i=0;i<s.length;i++) b[i] = s.charCodeAt(i) & 255; return b; };

  /* --------------------------------------------------------------- tokenizer
     Returns operators with their operands and byte span [s, e). */
  function parseContent(b){
    const n = b.length, ops = []; let i = 0;
    function skip(){ for(;;){ while(i<n && isWS(b[i])) i++; if(i<n && b[i]===0x25){ while(i<n && b[i]!==0x0a && b[i]!==0x0d) i++; } else break; } }
    function word(){ const s=i; while(i<n && !isWS(b[i]) && !isDelim(b[i])) i++; return latin1(b.subarray(s,i)); }
    function value(){
      skip(); const c = b[i];
      if(c===0x2f){ i++; let s=i; while(i<n && !isWS(b[i]) && !isDelim(b[i])) i++; return { t:'name', v: latin1(b.subarray(s,i)).replace(/#([0-9a-fA-F]{2})/g,(m,h)=>String.fromCharCode(parseInt(h,16))) }; }
      if(c===0x28){ // literal string
        i++; let depth=1; const out=[];
        while(i<n){
          let ch=b[i++];
          if(ch===0x5c){ // backslash
            const e=b[i++];
            if(e===0x6e) out.push(10); else if(e===0x72) out.push(13); else if(e===0x74) out.push(9); else if(e===0x62) out.push(8); else if(e===0x66) out.push(12);
            else if(e===0x28||e===0x29||e===0x5c) out.push(e);
            else if(e>=0x30 && e<=0x37){ let v=e-48, k=0; while(k<2 && b[i]>=0x30 && b[i]<=0x37){ v=v*8+(b[i++]-48); k++; } out.push(v&255); }
            else if(e===0x0d){ if(b[i]===0x0a) i++; }
            else if(e===0x0a){}
            else out.push(e);
          } else if(ch===0x28){ depth++; out.push(ch); }
          else if(ch===0x29){ if(--depth===0) break; out.push(ch); }
          else out.push(ch);
        }
        return { t:'str', bytes: Uint8Array.from(out) };
      }
      if(c===0x3c){
        if(b[i+1]===0x3c){ // dictionary (marked-content properties)
          i+=2; const d={};
          for(;;){ skip(); if(i>=n) break; if(b[i]===0x3e && b[i+1]===0x3e){ i+=2; break; } const k=value(); const v=value(); if(k && k.t==='name') d[k.v]=v; }
          return { t:'dict', v:d };
        }
        i++; let h='';
        while(i<n && b[i]!==0x3e){ if(!isWS(b[i])) h+=String.fromCharCode(b[i]); i++; }
        i++; if(h.length%2) h+='0';
        const out=new Uint8Array(h.length/2); for(let k=0;k<out.length;k++) out[k]=parseInt(h.substr(k*2,2),16);
        return { t:'str', bytes: out, hex:true };
      }
      if(c===0x5b){ i++; const items=[]; for(;;){ skip(); if(i>=n) break; if(b[i]===0x5d){ i++; break; } items.push(value()); } return { t:'arr', items }; }
      if(c===0x5d || c===0x3e || c===0x29 || c===0x7b || c===0x7d){ i++; return { t:'junk' }; }
      const w = word();
      if(/^[+\-]?(\d+\.?\d*|\.\d+)$/.test(w)) return { t:'num', v: parseFloat(w) };
      if(w==='true'||w==='false') return { t:'bool', v: w==='true' };
      if(w==='null') return { t:'null' };
      if(w==='') { i++; return { t:'junk' }; }
      return { t:'op', v:w };
    }
    let args=[], argStart=-1;
    while(i<n){
      skip(); if(i>=n) break;
      const s=i, v=value();
      if(v.t==='op'){
        if(v.v==='BI'){ // inline image: skip binary data up to EI
          let j=i; while(j<n-1 && !(b[j]===0x49 && b[j+1]===0x44 && isWS(b[j-1]) && (isWS(b[j+2])||j+2>=n))) j++;
          j+=3; while(j<n-1 && !(isWS(b[j-1]) && b[j]===0x45 && b[j+1]===0x49 && (j+2>=n || isWS(b[j+2])))) j++;
          i=Math.min(n,j+2); ops.push({ op:'BI', args:[], s:(argStart>=0?argStart:s), e:i }); args=[]; argStart=-1; continue;
        }
        ops.push({ op:v.v, args, s:(argStart>=0?argStart:s), e:i }); args=[]; argStart=-1;
      } else if(v.t!=='junk'){ if(argStart<0) argStart=s; args.push(v); }
    }
    return ops;
  }

  /* ------------------------------------------------------------ CMap parsing */
  function utf16be(bytes){ let s=''; for(let k=0;k+1<bytes.length;k+=2) s+=String.fromCharCode((bytes[k]<<8)|bytes[k+1]); if(bytes.length%2) s+=String.fromCharCode(bytes[bytes.length-1]); return s; }
  function hexBytes(h){ h=h.replace(/\s+/g,''); if(h.length%2) h+='0'; const out=new Uint8Array(h.length/2); for(let k=0;k<out.length;k++) out[k]=parseInt(h.substr(k*2,2),16); return out; }
  const bytesToInt = bs => { let v=0; for(const x of bs) v=v*256+x; return v; };
  function parseToUnicode(text){
    const map = new Map(); let codeLen = 0;
    const cs = /begincodespacerange([\s\S]*?)endcodespacerange/g; let m;
    while((m=cs.exec(text))){ const hs = m[1].match(/<([0-9a-fA-F\s]*)>/g)||[]; for(const h of hs){ codeLen = Math.max(codeLen, h.replace(/[<>\s]/g,'').length/2); } }
    const bc = /beginbfchar([\s\S]*?)endbfchar/g;
    while((m=bc.exec(text))){ const re=/<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>/g; let p; while((p=re.exec(m[1]))){ const src=hexBytes(p[1]); map.set(bytesToInt(src), utf16be(hexBytes(p[2]))); if(!codeLen) codeLen=src.length; } }
    const br = /beginbfrange([\s\S]*?)endbfrange/g;
    while((m=br.exec(text))){
      const re=/<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>\s*(<[0-9a-fA-F\s]*>|\[[^\]]*\])/g; let p;
      while((p=re.exec(m[1]))){
        const lo=bytesToInt(hexBytes(p[1])), hi=bytesToInt(hexBytes(p[2]));
        if(!codeLen) codeLen=hexBytes(p[1]).length;
        if(hi-lo > 65535) continue;
        if(p[3][0]==='['){ const arr=p[3].match(/<([0-9a-fA-F\s]*)>/g)||[]; arr.forEach((h,k)=>{ if(lo+k<=hi) map.set(lo+k, utf16be(hexBytes(h.replace(/[<>]/g,'')))); }); }
        else { const dst=hexBytes(p[3].replace(/[<>]/g,'')); for(let c=lo;c<=hi;c++){ const d=dst.slice(); let carry=c-lo, k=d.length-1; while(carry>0 && k>=0){ const v=d[k]+carry; d[k]=v&255; carry=v>>8; k--; } map.set(c, utf16be(d)); } }
      }
    }
    return { map, codeLen: codeLen || 1 };
  }

  /* ------------------------------------------------------- encodings & names */
  let WIN = null;
  // Windows-1252 (WinAnsiEncoding): Latin-1 plus these characters in 0x80-0x9F
  const CP1252 = {0x80:0x20AC,0x82:0x201A,0x83:0x0192,0x84:0x201E,0x85:0x2026,0x86:0x2020,0x87:0x2021,0x88:0x02C6,0x89:0x2030,0x8A:0x0160,0x8B:0x2039,0x8C:0x0152,0x8E:0x017D,0x91:0x2018,0x92:0x2019,0x93:0x201C,0x94:0x201D,0x95:0x2022,0x96:0x2013,0x97:0x2014,0x98:0x02DC,0x99:0x2122,0x9A:0x0161,0x9B:0x203A,0x9C:0x0153,0x9E:0x017E,0x9F:0x0178};
  function winAnsi(){ if(WIN) return WIN; WIN = new Map();
    for(let c=32;c<256;c++){ if(c>=0x7F && c<=0x9F){ if(CP1252[c]) WIN.set(c, String.fromCharCode(CP1252[c])); } else WIN.set(c, String.fromCharCode(c)); }
    return WIN; }
  const AGL = { space:' ', exclam:'!', quotedbl:'"', numbersign:'#', dollar:'$', percent:'%', ampersand:'&', quotesingle:"'", quoteright:'’', quoteleft:'‘', parenleft:'(', parenright:')', asterisk:'*', plus:'+', comma:',', hyphen:'-', minus:'−', period:'.', slash:'/', colon:':', semicolon:';', less:'<', equal:'=', greater:'>', question:'?', at:'@', bracketleft:'[', backslash:'\\', bracketright:']', asciicircum:'^', underscore:'_', grave:'`', braceleft:'{', bar:'|', braceright:'}', asciitilde:'~', Euro:'€', endash:'–', emdash:'—', quotedblleft:'“', quotedblright:'”', quotedblbase:'„', quotesinglbase:'‚', bullet:'•', ellipsis:'…', degree:'°', copyright:'©', registered:'®', trademark:'™', section:'§', paragraph:'¶', multiply:'×', divide:'÷', nbspace:' ', zero:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9', fi:'fi', fl:'fl', sterling:'£', yen:'¥', cent:'¢', plusminus:'±', guillemotleft:'«', guillemotright:'»', periodcentered:'·' };
  function glyphToUni(name){
    if(!name) return null;
    if(AGL[name]) return AGL[name];
    if(/^[A-Za-z]$/.test(name)) return name;
    let m = /^uni([0-9A-Fa-f]{4})/.exec(name); if(m) return String.fromCharCode(parseInt(m[1],16));
    m = /^u([0-9A-Fa-f]{4,6})$/.exec(name); if(m) return String.fromCodePoint(parseInt(m[1],16));
    m = /^afii(\d{5})$/.exec(name);
    if(m){ const k=+m[1]; const spec={10023:0x401,10071:0x451,10051:0x402,10052:0x403,10053:0x404,10054:0x405,10055:0x406,10056:0x407,10057:0x408,10058:0x409,10059:0x40A,10060:0x40B,10061:0x40C,10062:0x40E,10145:0x40F,10099:0x452,10100:0x453,10101:0x454,10102:0x455,10103:0x456,10104:0x457,10105:0x458,10106:0x459,10107:0x45A,10108:0x45B,10109:0x45C,10110:0x45E,10193:0x45F};
      if(spec[k]) return String.fromCharCode(spec[k]);
      if(k>=10017&&k<=10022) return String.fromCharCode(0x410+k-10017);
      if(k>=10024&&k<=10049) return String.fromCharCode(0x416+k-10024);
      if(k>=10065&&k<=10070) return String.fromCharCode(0x430+k-10065);
      if(k>=10072&&k<=10097) return String.fromCharCode(0x436+k-10072); }
    m = /^([A-Za-z]+)\.(.+)$/.exec(name); if(m) return glyphToUni(m[1]);
    return null;
  }

  /* --------------------------------------------------------------- fonts */
  const nameOf = o => (o && o.decodeText) ? o.decodeText() : (o && o.asString ? o.asString().replace(/^\//,'') : null);
  const num = o => (o instanceof PDFNumber) ? o.asNumber() : (typeof o === 'number' ? o : null);
  const arr = (doc, o) => { o = (o instanceof PDFRef) ? doc.context.lookup(o) : o; return (o instanceof PDFArray) ? o.asArray().map(x => (x instanceof PDFRef) ? doc.context.lookup(x) : x) : null; };
  const STD14 = { 'Helvetica':'Helvetica','Helvetica-Bold':'HelveticaBold','Helvetica-Oblique':'HelveticaOblique','Helvetica-BoldOblique':'HelveticaBoldOblique','Times-Roman':'TimesRoman','Times-Bold':'TimesRomanBold','Times-Italic':'TimesRomanItalic','Times-BoldItalic':'TimesRomanBoldItalic','Courier':'Courier','Courier-Bold':'CourierBold','Courier-Oblique':'CourierOblique','Courier-BoldOblique':'CourierBoldOblique','Arial':'Helvetica','Arial,Bold':'HelveticaBold','ArialMT':'Helvetica','Arial-BoldMT':'HelveticaBold','TimesNewRoman':'TimesRoman','TimesNewRomanPSMT':'TimesRoman','TimesNewRoman,Bold':'TimesRomanBold' };

  function loadFont(doc, dict, resName, stdCache){
    const g = k => dict.lookup(PDFName.of(k));
    const subtype = nameOf(g('Subtype')) || '';
    const base = nameOf(g('BaseFont')) || resName;
    const clean = base.replace(/^[A-Z]{6}\+/, '');
    const f = { res:resName, base, clean, subtype, subset:/^[A-Z]{6}\+/.test(base),
      bold: /bold|black|heavy|semibold|demibold|extrabold/i.test(clean), italic:/italic|oblique/i.test(clean),
      serif: /times|serif|georgia|garamond|cambria|book|minion|palatino/i.test(clean) && !/sans/i.test(clean),
      codeLen:1, toUni:new Map(), widths:new Map(), dw:500, ok:true, why:'' };
    if(subtype==='Type3'){ f.ok=false; f.why='type3'; return f; }
    // ToUnicode
    const tu = g('ToUnicode');
    if(tu && tu.contents !== undefined){ try{ const p = parseToUnicode(latin1(decodePDFRawStream(tu).decode())); f.toUni = p.map; f.hasToUni = p.map.size>0; if(subtype!=='Type0') f.codeLen = 1; }catch(e){} }
    if(subtype==='Type0'){
      const enc = nameOf(g('Encoding'));
      if(enc !== 'Identity-H'){ f.ok=false; f.why='encoding'; return f; }
      f.codeLen = 2;
      const desc = arr(doc, g('DescendantFonts')); const d = desc && desc[0];
      if(d){ const dwv = num(d.lookup(PDFName.of('DW'))); f.dw = dwv!=null ? dwv : 1000;
        const W = arr(doc, d.lookup(PDFName.of('W')));
        if(W){ for(let k=0;k<W.length;){ const a=num(W[k]); const nx=W[k+1];
          if(nx instanceof PDFArray || (nx instanceof PDFRef && doc.context.lookup(nx) instanceof PDFArray)){ const ws=arr(doc,nx); ws.forEach((w,j)=>f.widths.set(a+j, num(w))); k+=2; }
          else { const b2=num(nx), w=num(W[k+2]); if(b2-a < 70000) for(let c=a;c<=b2;c++) f.widths.set(c,w); k+=3; } } }
        const fd = d.lookup(PDFName.of('FontDescriptor')); if(fd){ f.embedded = !!(fd.lookup(PDFName.of('FontFile2')) || fd.lookup(PDFName.of('FontFile3')) || fd.lookup(PDFName.of('FontFile'))); }
      }
      if(!f.hasToUni){ f.ok=false; f.why='nounicode'; }
      return f;
    }
    // simple fonts: widths
    const fc = num(g('FirstChar')), W = arr(doc, g('Widths'));
    const fd = g('FontDescriptor');
    if(fd){ const mw = num(fd.lookup(PDFName.of('MissingWidth'))); if(mw!=null) f.dw = mw; f.embedded = !!(fd.lookup(PDFName.of('FontFile2')) || fd.lookup(PDFName.of('FontFile3')) || fd.lookup(PDFName.of('FontFile'))); }
    if(W && fc!=null) W.forEach((w,j)=>f.widths.set(fc+j, num(w)));
    else if(STD14[clean]){ f.std = STD14[clean]; }
    // encoding -> unicode (used when there is no ToUnicode map)
    const encMap = new Map(winAnsi());
    const encObj = g('Encoding');
    if(encObj instanceof PDFDict){
      const diffs = arr(doc, encObj.lookup(PDFName.of('Differences')));
      if(diffs){ let code=0; for(const x of diffs){ const nv=num(x); if(nv!=null) code=nv; else { const u=glyphToUni(nameOf(x)); if(u) encMap.set(code,u); else encMap.delete(code); code++; } } }
    }
    f.encMap = encMap;
    if(!f.hasToUni){ for(const [c,u] of encMap) f.toUni.set(c,u); }
    return f;
  }
  async function stdWidth(doc, f, stdCache){
    if(!f.std) return;
    if(!stdCache[f.std]) stdCache[f.std] = await doc.embedFont(StandardFonts[f.std]);
    const sf = stdCache[f.std];
    for(const [c,u] of f.toUni){ try{ f.widths.set(c, sf.widthOfTextAtSize(u, 1000)); }catch(e){} }
  }
  const glyphW = (f, c) => { const w = f.widths.get(c); return (w==null ? f.dw : w); };

  function decodeCodes(f, bytes){
    const codes=[]; if(f.codeLen===2){ for(let k=0;k+1<bytes.length;k+=2) codes.push((bytes[k]<<8)|bytes[k+1]); } else for(const x of bytes) codes.push(x);
    return codes;
  }

  /* ------------------------------------------------------------- matrices */
  const mul = (m,n) => [ m[0]*n[0]+m[1]*n[2], m[0]*n[1]+m[1]*n[3], m[2]*n[0]+m[3]*n[2], m[2]*n[1]+m[3]*n[3], m[4]*n[0]+m[5]*n[2]+n[4], m[4]*n[1]+m[5]*n[3]+n[5] ];

  /* ------------------------------------------------------- page content I/O */
  function pageContentBytes(doc, page){
    const c = page.node.Contents(); if(!c) return new Uint8Array(0);
    const streams = (c instanceof PDFArray) ? c.asArray().map(r => doc.context.lookup(r)) : [ c ];
    const parts = streams.map(s => decodePDFRawStream(s).decode());
    const total = parts.reduce((a,p)=>a+p.length+1, 0), out = new Uint8Array(total); let o=0;
    for(const p of parts){ out.set(p,o); o+=p.length; out[o++]=0x0a; }
    return out;
  }
  function fontResources(doc, page){
    const res = page.node.Resources(); const out = {};
    const fd = res && res.lookup(PDFName.of('Font'));
    if(fd instanceof PDFDict){ for(const [k,v] of fd.entries()){ const d = (v instanceof PDFRef) ? doc.context.lookup(v) : v; if(d instanceof PDFDict) out[nameOf(k)] = d; } }
    return out;
  }

  /* ------------------------------------------------------------- colour spaces */
  // Reads the page's named colour spaces so text colours can be shown and reproduced exactly.
  function colorSpaces(doc, page){
    const out = {}, res = page.node.Resources();
    const cd = res && res.lookup(PDFName.of('ColorSpace'));
    if(cd instanceof PDFDict){ for(const [k,v] of cd.entries()){ try{ out[nameOf(k)] = describeCS(doc, v, 0); }catch(e){ out[nameOf(k)] = { kind:'unknown' }; } } }
    return out;
  }
  const deref = (doc, o) => (o instanceof PDFRef) ? doc.context.lookup(o) : o;
  function describeCS(doc, o, depth){
    o = deref(doc, o);
    if(depth > 4) return { kind:'unknown' };
    if(o && !(o instanceof PDFArray)){
      const n = nameOf(o);
      if(n==='DeviceGray'||n==='G'||n==='CalGray') return { kind:'dev', n:1 };
      if(n==='DeviceRGB'||n==='RGB'||n==='CalRGB') return { kind:'dev', n:3 };
      if(n==='DeviceCMYK'||n==='CMYK') return { kind:'dev', n:4 };
      if(n==='Pattern') return { kind:'pattern' };
      return { kind:'unknown' };
    }
    const a = o.asArray().map(x => deref(doc, x)), fam = nameOf(a[0]);
    if(fam==='CalGray') return { kind:'dev', n:1 };
    if(fam==='CalRGB') return { kind:'dev', n:3 };
    if(fam==='ICCBased'){
      const st = a[1], d = st && !(st instanceof PDFDict) && st.dict instanceof PDFDict ? st.dict : null; const N = d ? num(d.lookup(PDFName.of('N'))) : null;
      if(N===1||N===3||N===4) return { kind:'dev', n:N };
      const alt = d && d.lookup(PDFName.of('Alternate')); return alt ? describeCS(doc, alt, depth+1) : { kind:'unknown' };
    }
    if(fam==='Lab'){ return { kind:'lab' }; }
    if(fam==='Indexed'){
      const base = describeCS(doc, a[1], depth+1), hi = num(a[2]) || 0; let lut = a[3], bytes = null;
      try{
        if(lut && lut.asBytes) bytes = lut.asBytes();
        else if(lut && lut.decodeText){ bytes = Uint8Array.from(lut.decodeText(), c => c.charCodeAt(0) & 255); }
        else if(lut && lut.dict){ bytes = decodePDFRawStream(lut).decode(); }
      }catch(e){}
      return { kind:'indexed', base, hi, bytes };
    }
    if(fam==='Separation' || fam==='DeviceN'){
      const names = fam==='Separation' ? [nameOf(a[1])] : (a[1] instanceof PDFArray ? a[1].asArray().map(nameOf) : []);
      return { kind:'sep', names, alt: describeCS(doc, a[2], depth+1), fn: readFn(doc, a[3]) };
    }
    if(fam==='Pattern') return { kind:'pattern' };
    return { kind:'unknown' };
  }
  function readFn(doc, f){
    f = deref(doc, f); const isStream = f && !(f instanceof PDFDict) && f.dict instanceof PDFDict; const d = isStream ? f.dict : f; if(!(d instanceof PDFDict)) return null;
    const g = k => d.lookup(PDFName.of(k)), nums = k => { const v = arr(doc, g(k)); return v ? v.map(num) : null; };
    const type = num(g('FunctionType'));
    if(type===2) return { type:2, C0: nums('C0') || [0], C1: nums('C1') || [1], N: num(g('N')) ?? 1 };
    if(type===0 && isStream){ // sampled: read the extremes (tint 0 and tint 1) as a linear ramp
      try{ const bps = num(g('BitsPerSample')), sz = nums('Size'), rng = nums('Range'), raw = decodePDFRawStream(f).decode(); const nOut = rng.length/2;
        if(bps===8 && sz && sz.length===1){ const last = (sz[0]-1)*nOut; const at = (i,j) => rng[2*j] + raw[i+j]/255*(rng[2*j+1]-rng[2*j]);
          return { type:2, C0: Array.from({length:nOut},(_,j)=>at(0,j)), C1: Array.from({length:nOut},(_,j)=>at(last,j)), N:1 }; } }catch(e){}
    }
    return null;
  }
  const clamp01 = x => Math.max(0, Math.min(1, x));
  function devToRgb(n, v){
    if(n===1) return [v[0],v[0],v[0]].map(clamp01);
    if(n===3) return v.slice(0,3).map(clamp01);
    if(n===4){ const k=v[3]; return [ (1-v[0])*(1-k), (1-v[1])*(1-k), (1-v[2])*(1-k) ].map(clamp01); }
    return null;
  }
  function labToRgb(L, A, B){
    let y = (L+16)/116, x = A/500 + y, z = y - B/200;
    const f = t => t**3 > 0.008856 ? t**3 : (t - 16/116)/7.787;
    x = 0.95047*f(x); y = f(y); z = 1.08883*f(z);
    let r = x*3.2406 + y*-1.5372 + z*-0.4986, g = x*-0.9689 + y*1.8758 + z*0.0415, b = x*0.0557 + y*-0.2040 + z*1.0570;
    const gam = c => c > 0.0031308 ? 1.055*Math.pow(c, 1/2.4) - 0.055 : 12.92*c;
    return [gam(r), gam(g), gam(b)].map(clamp01);
  }
  // approximate sRGB of values in a described colour space, or null when it can't be worked out
  function csToRgb(cs, v){
    if(!cs) return null;
    if(cs.kind==='dev') return v.length===cs.n ? devToRgb(cs.n, v) : null;
    if(cs.kind==='lab') return v.length===3 ? labToRgb(v[0], v[1], v[2]) : null;
    if(cs.kind==='indexed'){
      const n = cs.base && cs.base.kind==='dev' ? cs.base.n : 0; if(!n || !cs.bytes) return null;
      const i = Math.max(0, Math.min(cs.hi, Math.round(v[0]||0))) * n; if(i + n > cs.bytes.length) return null;
      return devToRgb(n, Array.from(cs.bytes.slice(i, i+n), b => b/255));
    }
    if(cs.kind==='sep'){
      if(cs.names.length===1 && cs.names[0]==='None') return null;
      if(cs.fn && cs.fn.type===2 && v.length===1){ const t = Math.pow(clamp01(v[0]), cs.fn.N); const out = cs.fn.C0.map((c0,j) => c0 + t*((cs.fn.C1[j] ?? c0) - c0)); return csToRgb(cs.alt, out); }
      // unknown tint function: a single "Black"/"All" ink is ink-on-paper
      if(v.length===1 && /^(Black|All|K)$/i.test(cs.names[0]||'')) return [1-v[0],1-v[0],1-v[0]].map(clamp01);
      return null;
    }
    return null;
  }

  /* ------------------------------------------------------------- analysis */
  async function analyzePage(doc, pageIndex){
    const page = doc.getPage(pageIndex);
    const bytes = pageContentBytes(doc, page);
    const ops = parseContent(bytes);
    const fontDicts = fontResources(doc, page), fonts = {}, stdCache = {}, CS = colorSpaces(doc, page);
    for(const k in fontDicts){ fonts[k] = loadFont(doc, fontDicts[k], k, stdCache); await stdWidth(doc, fonts[k], stdCache); }

    // graphics + text state
    let CTM=[1,0,0,1,0,0], gstack=[], fill={ t:'g', v:[0] }, fillCS='DeviceGray', strokeless=true;
    let Tm=[1,0,0,1,0,0], Tlm=[1,0,0,1,0,0], Tc=0, Tw=0, Th=1, TL=0, Tfs=12, Ts=0, Tr=0, font=null, inText=false;
    const segs = []; const usedCodes = {};
    const show = (op, opIndex, elems) => {
      // elems: [{t:'str',bytes} | {t:'num',v}] ; produces segments split at wide gaps
      const M = mul(Tm, CTM), S = Math.hypot(M[0], M[1]), V = Math.hypot(M[2], M[3]);
      const rotated = Math.abs(M[1]) > 1e-3*Math.abs(M[0]) || Math.abs(M[2]) > 1e-3*Math.abs(M[3]) || M[0] <= 0 || M[3] <= 0;
      let cur = null;
      const start = (ei) => { const Trm = mul([Tfs*Th,0,0,Tfs,0,Ts], mul(Tm, CTM)); cur = { opIndex, op, e0:ei, e1:ei, x0:Trm[4], y:Trm[5], size:Tfs*V, S, Tfs, Th, Tc, Tw, adv:0, text:'', codes:[], font, fill:{...fill, v:fill.v.slice()}, rotated, hidden:(Tr===3||Tr===7) }; };
      const finish = () => { if(cur && cur.codes.length){ cur.x1 = cur.x0 + cur.adv*S; segs.push(cur); } cur=null; };
      elems.forEach((el, ei) => {
        if(el.t==='num'){
          const tx = -el.v/1000*Tfs*Th; const gapEm = -el.v/1000;
          if(cur && gapEm > 0.8){ finish(); }
          else if(cur){ if(gapEm > 0.15 && !/\s$/.test(cur.text)) cur.text += ' '; cur.adv += tx; cur.e1 = ei; }
          Tm = mul([1,0,0,1,tx,0], Tm);
          return;
        }
        if(el.t!=='str' || !font) return;
        const codes = decodeCodes(font, el.bytes);
        if(!cur) start(ei);
        (usedCodes[font.res] = usedCodes[font.res] || new Set());
        for(const c of codes){
          usedCodes[font.res].add(c);
          const w = glyphW(font, c)/1000;
          const tx = (w*Tfs + Tc + ((font.codeLen===1 && c===32) ? Tw : 0))*Th;
          const u = font.toUni.get(c); cur.text += (u == null ? '\ufffd' : u); cur.codes.push(c);
          cur.adv += tx; Tm = mul([1,0,0,1,tx,0], Tm);
        }
        cur.e1 = ei;
      });
      finish();
    };
    ops.forEach((o, idx) => {
      const a = o.args, nv = k => (a[k] && a[k].t==='num') ? a[k].v : 0;
      switch(o.op){
        case 'q': gstack.push({ CTM:CTM.slice(), fill:{...fill, v:fill.v.slice()}, fillCS }); break;
        case 'Q': { const s = gstack.pop(); if(s){ CTM=s.CTM; fill=s.fill; fillCS=s.fillCS; } break; }
        case 'cm': CTM = mul([nv(0),nv(1),nv(2),nv(3),nv(4),nv(5)], CTM); break;
        case 'g': fill={ t:'g', v:[nv(0)] }; break;
        case 'rg': fill={ t:'rg', v:[nv(0),nv(1),nv(2)] }; break;
        case 'k': fill={ t:'k', v:[nv(0),nv(1),nv(2),nv(3)] }; break;
        case 'cs': { fillCS = a[0] && a[0].v;
          const d = describeCS(doc, PDFName.of(fillCS||''), 0); const cs = CS[fillCS] || d;
          // a new colour space starts at its initial colour: black for device/ICC/Lab, full tint for separations, index 0
          if(cs.kind==='dev') fill = cs.n===4 ? { t:'k', v:[0,0,0,1] } : cs.n===3 ? { t:'rg', v:[0,0,0] } : { t:'g', v:[0] };
          else { const v0 = cs.kind==='sep' ? cs.names.map(()=>1) : cs.kind==='lab' ? [0,0,0] : [0]; fill = { t:'cs', cs:fillCS, v:v0, rgb: csToRgb(cs, v0) }; }
          break; }
        case 'sc': case 'scn': {
          const vs = a.filter(x=>x.t==='num').map(x=>x.v);
          const cs = CS[fillCS] || describeCS(doc, PDFName.of(fillCS||''), 0);
          if(cs.kind==='pattern' || cs.kind==='unknown' && a.some(x=>x.t==='name')) { fill = { t:'cs', cs:fillCS, v:vs, pat: a.find(x=>x.t==='name') ? a.find(x=>x.t==='name').v : null, rgb:null }; break; }
          if(cs.kind==='dev' && vs.length===cs.n){ fill = cs.n===3 ? {t:'rg',v:vs} : cs.n===4 ? {t:'k',v:vs} : {t:'g',v:vs}; break; }
          if(cs.kind==='unknown'){ if(vs.length===3) fill={t:'rg',v:vs}; else if(vs.length===1) fill={t:'g',v:vs}; else if(vs.length===4) fill={t:'k',v:vs}; break; }
          // separations, DeviceN, Lab, Indexed: keep the original colour exactly, plus an sRGB approximation for display
          fill = { t:'cs', cs:fillCS, v:vs, rgb: csToRgb(cs, vs) };
          break; }
        case 'BT': Tm=[1,0,0,1,0,0]; Tlm=[1,0,0,1,0,0]; inText=true; break;
        case 'ET': inText=false; break;
        case 'Tf': font = fonts[a[0] && a[0].v] || null; Tfs = nv(1); break;
        case 'Tc': Tc=nv(0); break; case 'Tw': Tw=nv(0); break; case 'Tz': Th=nv(0)/100; break; case 'TL': TL=nv(0); break; case 'Ts': Ts=nv(0); break; case 'Tr': Tr=nv(0); break;
        case 'Td': Tlm = mul([1,0,0,1,nv(0),nv(1)], Tlm); Tm = Tlm.slice(); break;
        case 'TD': TL = -nv(1); Tlm = mul([1,0,0,1,nv(0),nv(1)], Tlm); Tm = Tlm.slice(); break;
        case 'Tm': Tlm = [nv(0),nv(1),nv(2),nv(3),nv(4),nv(5)]; Tm = Tlm.slice(); break;
        case 'T*': Tlm = mul([1,0,0,1,0,-TL], Tlm); Tm = Tlm.slice(); break;
        case 'Tj': if(a[0] && a[0].t==='str') show('Tj', idx, [a[0]]); break;
        case 'TJ': if(a[0] && a[0].t==='arr') show('TJ', idx, a[0].items); break;
        case "'": Tlm = mul([1,0,0,1,0,-TL], Tlm); Tm = Tlm.slice(); if(a[0]) show("'", idx, [a[0]]); break;
        case '"': Tw=nv(0); Tc=nv(1); Tlm = mul([1,0,0,1,0,-TL], Tlm); Tm = Tlm.slice(); if(a[2]) show('"', idx, [a[2]]); break;
      }
    });

    // available codes per font, for exact (same-font) re-encoding
    for(const k in fonts){
      const f = fonts[k]; const avail = new Set();
      if(f.hasToUni) for(const c of f.toUni.keys()) avail.add(c);
      else if(f.subset || f.embedded) (usedCodes[k]||[]).forEach(c=>avail.add(c));
      else for(const c of f.toUni.keys()) avail.add(c);
      const rev = new Map();
      for(const c of avail){ const u = f.toUni.get(c); if(u && [...u].length===1 && !rev.has(u)) rev.set(u, c); }
      f.rev = rev;
    }

    // group segments into lines
    const lines = [];
    for(const s of segs){
      const prev = lines[lines.length-1], last = prev && prev.segs[prev.segs.length-1];
      const ok = last && last.font===s.font && Math.abs(last.size - s.size) < 0.5 && Math.abs(last.y - s.y) < 0.2*s.size
        && (s.x0 - last.x1) > -0.2*s.size && (s.x0 - last.x1) < 0.8*s.size && !last.rotated && !s.rotated && last.hidden===s.hidden;
      if(ok){ if((s.x0 - last.x1) > 0.15*s.size && !/\s$/.test(prev.text) && !/^\s/.test(s.text)) prev.text += ' '; prev.text += s.text; prev.segs.push(s); prev.x1 = s.x1; }
      else lines.push({ segs:[s], text:s.text, x0:s.x0, x1:s.x1, y:s.y, size:s.size, font:s.font });
    }
    lines.forEach((ln, id) => {
      ln.id = id; ln.text = ln.text.replace(/\s+$/,'').replace(/^\s+/,'');
      const f = ln.font, first = ln.segs[0];
      ln.editable = true; ln.why = '';
      if(!f || !f.ok){ ln.editable=false; ln.why = f ? f.why : 'nofont'; }
      else if(first.rotated){ ln.editable=false; ln.why='rotated'; }
      else if(first.hidden){ ln.editable=false; ln.why='hidden'; }
      else if(ln.text.indexOf('\ufffd')>=0){ ln.editable=false; ln.why='nounicode'; }
      else if(!ln.text){ ln.editable=false; ln.why='empty'; }
      ln.ascent = 0.8*ln.size; ln.descent = 0.22*ln.size;
      ln.numeric = /^[\s\d.,:\-+%€$£()\/]*\d[\s\d.,:\-+%€$£()\/A-Za-zА-Яа-я]*$/.test(ln.text) && /\d/.test(ln.text) && ln.text.replace(/[^\d]/g,'').length >= ln.text.replace(/\s/g,'').length*0.5;
      ln.fontLabel = f ? f.clean : '';
    });
    return { page:pageIndex, lines, fonts, ops, bytes, size: page.getSize() };
  }

  /* exact-encoding check: returns { exact:boolean, missing:[chars] } */
  function checkEncode(line, text){
    const f = line.font; const missing = [];
    if(!f || !f.rev) return { exact:false, missing:[...new Set([...text])] };
    for(const ch of text){ if(!f.rev.has(ch) && ch !== ' ') missing.push(ch); }
    return { exact: missing.length===0, missing: [...new Set(missing)] };
  }

  /* ----------------------------------------------------------- rewriting */
  const fmt = v => { const r = Math.round(v*1000)/1000; return (Object.is(r,-0) ? 0 : r).toString(); };
  const hex = (codes, len) => '<' + codes.map(c => c.toString(16).padStart(len*2,'0')).join('').toUpperCase() + '>';
  const serVal = (v) => {
    if(v.t==='num') return fmt(v.v);
    if(v.t==='str') return '<' + Array.from(v.bytes, x=>x.toString(16).padStart(2,'0')).join('').toUpperCase() + '>';
    if(v.t==='name') return '/' + v.v.replace(/[^\x21-\x7e]|[#()<>\[\]{}\/%]/g, ch => '#' + ch.charCodeAt(0).toString(16).padStart(2,'0'));
    if(v.t==='arr') return '[' + v.items.map(serVal).join(' ') + ']';
    return '';
  };
  function encodePieces(f, text, Tfs, Th, Tc, Tw){
    // returns { items:[{t:'str'|'num'}], adv } in text space
    const items = []; let codes = [], adv = 0;
    const flush = () => { if(codes.length){ items.push({ t:'raw', s: hex(codes, f.codeLen) }); codes = []; } };
    for(const ch of text){
      const c = f.rev.get(ch);
      if(c != null){ codes.push(c); adv += (glyphW(f,c)/1000*Tfs + Tc + ((f.codeLen===1 && c===32) ? Tw : 0))*Th; }
      else if(ch === ' '){ flush(); const em = 0.25; items.push({ t:'raw', s: fmt(-em*1000) }); adv += em*Tfs*Th; }
    }
    flush();
    return { items, adv };
  }

  const famOf = n => { let f = (n||'').replace(/^[A-Z]{6}\+/,''), prev; do { prev = f; f = f.replace(/[-,_ ]?(Bold|Black|Heavy|Semibold|SemiBold|DemiBold|ExtraBold|Medium|Light|Italic|Oblique|Regular|Roman|Book|MT|PS|PSMT)$/i,''); } while(f !== prev); return f.replace(/[-,_ ]+$/,'').toLowerCase(); };
  const canEnc = (f, s) => !!(f && f.ok && f.rev) && [...s].every(ch => ch === ' ' || f.rev.has(ch));
  const hexToFill = h => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h||''); return m ? { t:'rg', v:[parseInt(m[1],16)/255, parseInt(m[2],16)/255, parseInt(m[3],16)/255] } : null; };
  const colorOp = (c, stroke) => c.t==='cs' ? ('/' + c.cs + (stroke ? ' CS ' : ' cs ') + c.v.map(fmt).join(' ') + (c.pat ? ' /' + c.pat : '') + (stroke ? ' SCN' : ' scn')) : c.t==='rg' ? c.v.map(fmt).join(' ') + (stroke ? ' RG' : ' rg') : c.t==='k' ? c.v.map(fmt).join(' ') + (stroke ? ' K' : ' k') : fmt(c.v[0]) + (stroke ? ' G' : ' g');
  const toColor = c => c.t==='cs' ? (c.rgb ? rgb(c.rgb[0],c.rgb[1],c.rgb[2]) : grayscale(0)) : c.t==='rg' ? rgb(c.v[0],c.v[1],c.v[2]) : c.t==='k' ? cmyk(c.v[0],c.v[1],c.v[2],c.v[3]) : grayscale(c.v[0]);

  // New text that isn't in the file yet: borrows font, size and colour from a nearby line (ref), or the page's main font.
  function virtualLine(A, e){
    const ref = e.ref != null ? A.lines[e.ref] : null;
    let font = ref && ref.font && ref.font.ok && ref.font.rev ? ref.font : null;
    if(!font){
      const cnt = {};
      A.lines.forEach(l => { if(l.editable && l.font && l.font.ok && l.font.rev && !l.font.bold && !l.font.italic) cnt[l.font.res] = (cnt[l.font.res]||0) + l.text.length; });
      const best = Object.keys(cnt).sort((a,b) => cnt[b]-cnt[a])[0]; font = best ? A.fonts[best] : null;
    }
    const size = ref ? ref.size : 10, fill = ref && ref.segs[0] ? ref.segs[0].fill : { t:'g', v:[0] };
    return { virtual:true, id:e.line, x0:e.x, x1:e.x, y:e.y, size, font: font || { ok:false, bold:false, italic:false, serif:false, clean:'Helvetica' },
      segs:[{ fill, Tfs:size, Th:1, S:1, adv:0 }], editable:true, text:'', ascent:size*0.8, descent:size*0.2 };
  }
  async function applyEdits(doc, edits, opts){
    opts = opts || {};
    const byPage = {};
    edits.forEach(e => { (byPage[e.page] = byPage[e.page] || []).push(e); });
    const report = [];
    const fallback = {};
    const STDV = { Helvetica:['Helvetica','HelveticaBold','HelveticaOblique','HelveticaBoldOblique'], Times:['TimesRoman','TimesRomanBold','TimesRomanItalic','TimesRomanBoldItalic'], Courier:['Courier','CourierBold','CourierOblique','CourierBoldOblique'] };
    const getFallback = async (line, text, bold, italic, forced) => {
      const winSet = new Set(winAnsi().values());
      if([...text].every(ch => winSet.has(ch))){
        const fam = forced==='mono' ? 'Courier' : forced==='serif' ? 'Times' : forced==='sans' ? 'Helvetica' : (line.font && line.font.serif) ? 'Times' : 'Helvetica';
        const name = STDV[fam][(bold ? 1 : 0) + (italic ? 2 : 0)];
        if(!fallback[name]) fallback[name] = await doc.embedFont(StandardFonts[name]);
        return { font: fallback[name], label: fam, skew: 0 };
      }
      if(!opts.fontkit || !opts.fonts) throw new Error('No fallback font available for these characters');
      const key = bold ? 'bold' : 'regular';
      if(!fallback['inter-'+key]){ doc.registerFontkit(opts.fontkit); fallback['inter-'+key] = await doc.embedFont(opts.fonts[key], { subset:false, features:{ calt:false, liga:false, dlig:false, ss01:false } }); }
      return { font: fallback['inter-'+key], label: 'Inter', skew: italic ? 12 : 0 };
    };
    for(const p in byPage){
      const pi = +p, A = await analyzePage(doc, pi), page = doc.getPage(pi);
      const opRepl = {};   // opIndex -> Map(segment -> items)
      const draws = [], raw = [];
      const fontList = Object.values(A.fonts).filter(f => f.ok && f.rev);
      for(const e of byPage[p]){
        const ln = e.add ? virtualLine(A, e) : A.lines[e.line];
        if(!ln || !ln.editable){ report.push({ ...e, ok:false, why:'not-editable' }); continue; }
        const st = e.style || {}, of = ln.font;
        const restyled = (st.bold !== undefined && st.bold !== of.bold) || (st.italic !== undefined && st.italic !== of.italic) || (st.size && Math.abs(st.size - ln.size) > 0.05) || !!hexToFill(st.color)
          || !!st.underline || !!st.strike || !!hexToFill(st.highlight) || (st.family && st.family !== 'orig') || !!st.tracking || (st.hscale && st.hscale !== 100)
          || (st.leading && st.leading !== 1.25) || !!st.baseline || (st.opacity != null && st.opacity < 1);
        const multi = /\n/.test(e.text);
        const mv = e.move || { dx:0, dy:0 }, moved = Math.abs(mv.dx||0) > 0.01 || Math.abs(mv.dy||0) > 0.01;
        const dx = mv.dx || 0, dy = mv.dy || 0;
        const first = ln.segs[0], lineW = ln.x1 - ln.x0;
        const anchor = e.anchor || 'left';
        const put = (seg, items) => { (opRepl[seg.opIndex] = opRepl[seg.opIndex] || new Map()).set(seg, items); };
        const pure = seg => [{ t:'raw', s: fmt(-(seg.adv)*1000/(seg.Tfs*seg.Th)) }];
        if(!ln.virtual) ln.segs.forEach((s, k) => { if(k>0) put(s, pure(s)); });

        if(!restyled && !multi && !moved && !ln.virtual){
          // in-place replacement inside the original text operator
          const text = e.text.replace(/\s+/g,' ');
          const chk = checkEncode(ln, text);
          if(chk.exact && text.length){
            const enc = encodePieces(of, text, first.Tfs, first.Th, first.Tc, first.Tw);
            const newW = enc.adv * first.S;
            const shiftPage = anchor==='right' ? (lineW - newW) : anchor==='center' ? (lineW - newW)/2 : 0;
            const shiftT = shiftPage / first.S;
            const items = [];
            if(Math.abs(shiftT) > 1e-6) items.push({ t:'raw', s: fmt(-shiftT*1000/(first.Tfs*first.Th)) });
            items.push(...enc.items);
            const compT = first.adv - (shiftT + enc.adv);
            if(Math.abs(compT) > 1e-6) items.push({ t:'raw', s: fmt(-compT*1000/(first.Tfs*first.Th)) });
            put(first, items);
            report.push({ ...e, ok:true, mode:'exact', font: of.clean });
          } else {
            put(first, pure(first));
            if(text.length){
              const fb = await getFallback(ln, text, of.bold, of.italic);
              const w = fb.font.widthOfTextAtSize(text, ln.size);
              const shiftPage = anchor==='right' ? (lineW - w) : anchor==='center' ? (lineW - w)/2 : 0;
              draws.push({ text, x: ln.x0 + shiftPage, y: ln.y, size: ln.size, font: fb.font, color: toColor(first.fill), skew: fb.skew });
              report.push({ ...e, ok:true, mode:'fallback', font: fb.label, missing: chk.missing });
            } else report.push({ ...e, ok:true, mode:'removed' });
          }
          continue;
        }

        // restyled or multi-line: remove the original text and write new text blocks
        if(!ln.virtual) put(first, pure(first));
        const wantB = st.bold !== undefined ? st.bold : of.bold, wantI = st.italic !== undefined ? st.italic : of.italic;
        const baseSize = st.size || ln.size, lh = baseSize * (st.leading || 1.25);
        const size = st.baseline ? baseSize * 0.65 : baseSize, rise = st.baseline==='super' ? baseSize*0.35 : st.baseline==='sub' ? -baseSize*0.15 : 0;
        const fill = hexToFill(st.color) || first.fill, hl = hexToFill(st.highlight);
        const tc = st.tracking || 0, hs = st.hscale || 100, forced = st.family && st.family !== 'orig' ? st.family : null;
        const op = (st.opacity != null && st.opacity < 1) ? Math.max(0.05, st.opacity) : null;
        let gsName = null;
        if(op != null){ const gs = doc.context.obj({ Type:'ExtGState', ca: op, CA: op }); gsName = nameOf(page.node.newExtGState('EdGS', doc.context.register(gs))); }
        const deco = (x, y, w) => {  // highlight behind, underline / strike-through on top
          const pre = [], post = [];
          if(hl) pre.push('q ' + colorOp(hl) + ' ' + fmt(x - size*0.08) + ' ' + fmt(y - size*0.24) + ' ' + fmt(w + size*0.16) + ' ' + fmt(size*1.12) + ' re f Q');
          const th = fmt(Math.max(0.4, size*0.06));
          if(st.underline) post.push('q ' + (gsName ? '/' + gsName + ' gs ' : '') + colorOp(fill) + ' ' + fmt(x) + ' ' + fmt(y - size*0.13) + ' ' + fmt(w) + ' ' + th + ' re f Q');
          if(st.strike) post.push('q ' + (gsName ? '/' + gsName + ' gs ' : '') + colorOp(fill) + ' ' + fmt(x) + ' ' + fmt(y + size*0.27) + ' ' + fmt(w) + ' ' + th + ' re f Q');
          return { pre, post };
        };
        const fam = famOf(of.clean);
        const sameFam = fontList.filter(f => famOf(f.clean) === fam);
        const pick = lt => {
          for(const f of [of, ...sameFam]) if(f.bold === wantB && f.italic === wantI && canEnc(f, lt)) return { f, fb:false, fi:false };
          for(const f of [of, ...sameFam]) if(canEnc(f, lt) && (f.bold === wantB || (wantB && !f.bold)) && (f.italic === wantI || (wantI && !f.italic))) return { f, fb: wantB && !f.bold, fi: wantI && !f.italic };
          return null;
        };
        const lines = e.text.split('\n').map(x => x.replace(/[ \t]+/g,' ').trim());
        let anyFallback = null, wrote = false, usedFont = null;
        for(let i = 0; i < lines.length; i++){
          const lt = lines[i]; if(!lt) continue; wrote = true;
          const y = ln.y - i*lh + dy + rise, choice = forced ? null : pick(lt);
          const nch = [...lt].length;
          if(choice){
            const enc = encodePieces(choice.f, lt, size, 1, 0, 0); usedFont = usedFont || choice.f.clean;
            const w = (enc.adv + tc*nch) * hs/100;
            const x = (anchor==='right' ? ln.x1 - w : anchor==='center' ? ln.x0 + (lineW - w)/2 : ln.x0) + dx;
            const d = deco(x, y, w); raw.push(...d.pre);
            raw.push('q ' + (gsName ? '/' + gsName + ' gs ' : '') + 'BT ' + serVal({ t:'name', v: choice.f.res }) + ' ' + fmt(size) + ' Tf ' + fmt(tc) + ' Tc 0 Tw ' + fmt(hs) + ' Tz 0 Ts ' + colorOp(fill) + ' '
              + (choice.fb ? colorOp(fill, true) + ' ' + fmt(size*0.035) + ' w 2 Tr ' : '0 Tr ')
              + '1 0 ' + (choice.fi ? '0.2' : '0') + ' 1 ' + fmt(x) + ' ' + fmt(y) + ' Tm [' + enc.items.map(it => it.s).join(' ') + '] TJ ET Q');
            raw.push(...d.post);
          } else {
            const fb = await getFallback(ln, lt, wantB, wantI, forced); anyFallback = fb.label;
            const w = (fb.font.widthOfTextAtSize(lt, size) + tc*nch) * hs/100;
            const x = (anchor==='right' ? ln.x1 - w : anchor==='center' ? ln.x0 + (lineW - w)/2 : ln.x0) + dx;
            const d = deco(x, y, w); raw.push(...d.pre);
            draws.push({ text: lt, x, y, size, font: fb.font, color: toColor(fill), skew: fb.skew, tc, hs, opacity: op }); raw.push(...d.post);
          }
        }
        report.push({ ...e, ok:true, mode: !wrote ? 'removed' : anyFallback ? 'fallback' : 'exact', font: anyFallback || usedFont || of.clean, styled: restyled, moved, lines: lines.length });
      }
      // rebuild the content stream with replaced show operators
      const pieces = []; let pos = 0; const src = A.bytes;
      const idxs = Object.keys(opRepl).map(Number).sort((a,b)=>a-b);
      for(const oi of idxs){
        const o = A.ops[oi], repl = opRepl[oi];
        const elems = o.op==='TJ' ? o.args[0].items : o.op==='"' ? [o.args[2]] : [o.args[0]];
        const out = [];
        let ei = 0;
        const segsHere = [...repl.keys()].sort((a,b)=>a.e0-b.e0);
        for(const s of segsHere){
          for(; ei < s.e0; ei++) out.push(serVal(elems[ei]));
          out.push(...repl.get(s).map(it => it.s));
          ei = s.e1 + 1;
        }
        for(; ei < elems.length; ei++) out.push(serVal(elems[ei]));
        let txt = '[' + out.join(' ') + '] TJ';
        if(o.op==="'") txt = 'T* ' + txt;
        if(o.op==='"') txt = fmt(o.args[0].v) + ' Tw ' + fmt(o.args[1].v) + ' Tc T* ' + txt;
        pieces.push(src.subarray(pos, o.s), toBytes(txt));
        pos = o.e;
      }
      pieces.push(src.subarray(pos));
      if(raw.length){ pieces.unshift(toBytes('q\n')); pieces.push(toBytes('\nQ\n' + raw.join('\n') + '\n')); }
      const total = pieces.reduce((a,b)=>a+b.length,0), nb = new Uint8Array(total); let off=0; for(const pc of pieces){ nb.set(pc, off); off += pc.length; }
      const ref = doc.context.register(doc.context.flateStream(nb));
      page.node.set(PDFName.of('Contents'), doc.context.obj([ref]));
      for(const d of draws){
        const spaced = (d.tc && Math.abs(d.tc) > 1e-3) || (d.hs && d.hs !== 100);
        if(spaced) page.pushOperators(L.pushGraphicsState(), L.setCharacterSpacing(d.tc || 0), L.PDFOperator.of('Tz', [L.PDFNumber.of(d.hs || 100)]));
        page.drawText(d.text, { x:d.x, y:d.y, size:d.size, font:d.font, color:d.color, xSkew: L.degrees(d.skew || 0), opacity: d.opacity != null ? d.opacity : undefined });
        if(spaced) page.pushOperators(L.popGraphicsState());
      }
    }
    return report;
  }

  /* ---------------------------------------------------------- form fields */
  function listFields(doc){
    let form; try{ form = doc.getForm(); }catch(e){ return []; }
    const pages = doc.getPages(), out = [];
    for(const fld of form.getFields()){
      const kind = fieldKind(fld);
      if(!kind) continue;
      let widgets = []; try{ widgets = fld.acroField.getWidgets(); }catch(e){}
      widgets.forEach((w, wi) => {
        const r = w.getRectangle(); const pref = w.P();
        let pi = pages.findIndex(pg => pref && pg.ref === pref);
        if(pi < 0) pi = pages.findIndex(pg => { const an = pg.node.Annots(); return an && an.asArray().some(a => doc.context.lookup(a) === w.dict); });
        if(pi < 0) return;
        let value = '', options = [];
        try{ if(kind==='text') value = fld.getText() || ''; else if(kind==='check') value = fld.isChecked(); else { value = (fld.getSelected()||[])[0] || ''; options = fld.getOptions(); } }catch(e){}
        out.push({ name: fld.getName(), kind, page: pi, rect: r, value, options, readOnly: fld.isReadOnly ? fld.isReadOnly() : false, widget: wi });
      });
    }
    return out;
  }
  async function applyFields(doc, values, opts){
    const form = doc.getForm(); let needUni = false;
    for(const name in values){
      const v = values[name];
      try{
        const f = form.getField(name), kind = fieldKind(f);
        if(kind==='text'){ f.setText(String(v)); { const ws = new Set(winAnsi().values()); if([...String(v)].some(ch => !ws.has(ch))) needUni = true; } }
        else if(kind==='check'){ v ? f.check() : f.uncheck(); }
        else if(kind==='select'){ f.select(String(v)); }
      }catch(e){}
    }
    if(needUni && opts && opts.fontkit && opts.fonts){ doc.registerFontkit(opts.fontkit); const font = await doc.embedFont(opts.fonts.regular, { subset:false, features:{ calt:false, liga:false, dlig:false, ss01:false } }); form.updateFieldAppearances(font); }
    else { try{ form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica)); }catch(e){} }
  }

  const api = { parseContent, analyzePage, checkEncode, applyEdits, listFields, applyFields, virtualLine };
  if(typeof module !== 'undefined' && module.exports) module.exports = api; else root.PMEdit = api;
})(typeof self !== 'undefined' ? self : this);
