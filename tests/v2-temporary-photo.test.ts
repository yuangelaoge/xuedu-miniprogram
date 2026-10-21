import test from 'node:test';
import assert from 'node:assert/strict';
import {readTemporaryPhoto,temporaryPhotoUrl,PhotoFetch} from '../server/v2/temporary-photo';
const source='http://vweixinf.tc.qq.com/301/synthetic';
const jpeg=Buffer.from([255,216,255,217]);
const fake=(data:Uint8Array,status=200,headers:Record<string,string>={}):PhotoFetch=>async()=>new Response(data,{status,headers});

test('temporary photo download accepts JPEG/PNG bytes from the observed SDK URL without rewriting its protocol',async()=>{
  let fetched='',options:any;
  const fetcher:PhotoFetch=async(url,init)=>{fetched=url;options=init;return new Response(jpeg,{headers:{'content-length':'4'}});};
  assert.equal(await readTemporaryPhoto(source,4,1000,fetcher),jpeg.toString('base64'));
  assert.equal(fetched,source);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
  const png=Buffer.from([137,80,78,71,13,10,26,10]);
  assert.equal(await readTemporaryPhoto(source,8,1000,fake(png)),png.toString('base64'));
});

test('untrusted URLs, credentials, ports, fragments and disguised domains are rejected before network access',async()=>{
  let calls=0;const fetcher:PhotoFetch=async()=>{calls++;throw new Error('should not fetch');};
  for(const url of ['https://example.com/a','https://127.0.0.1/a','http://169.254.169.254/a','file:///etc/passwd','https://mmecimage.qpic.cn.evil.test/a','https://user:pass@mmecimage.qpic.cn/a','https://mmecimage.qpic.cn:8443/a',source+'#x','https://vweixinf.tc.qq.com/other/path','http://vweixinf.tc.qq.com:8080/301/x','http://vweixinf.tc.qq.com.evil.test/301/x','https://some.qq.com/301/x','https://mmecimage.qpic.cn\\@evil.test/a'])
    await assert.rejects(readTemporaryPhoto(url,4,1000,fetcher));
  assert.equal(calls,0);assert.equal(temporaryPhotoUrl(source),source);assert.equal(temporaryPhotoUrl(source.replace('http:','https:')),source.replace('http:','https:'));
});

test('expired URLs, redirects, wrong lengths, oversized streams and non-image content fail closed',async()=>{
  for(const response of [fake(jpeg,403),fake(jpeg,302,{location:'http://127.0.0.1'}),fake(jpeg,200,{'content-length':'9999999'}),fake(jpeg.subarray(0,3)),fake(Buffer.concat([jpeg,jpeg])),fake(Buffer.from('html'))])
    await assert.rejects(readTemporaryPhoto(source,4,1000,response));
  await assert.rejects(readTemporaryPhoto(source,5*1024*1024+1,1000,fake(jpeg)),/大小/);
});

test('download deadline aborts a stalled request',async()=>{
  let aborted=false;
  const fetcher:PhotoFetch=async(_url,options)=>new Promise((_resolve,reject)=>{
    (options.signal as AbortSignal).addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));});
  });
  await assert.rejects(readTemporaryPhoto(source,4,10,fetcher),/aborted/);assert.equal(aborted,true);
});
