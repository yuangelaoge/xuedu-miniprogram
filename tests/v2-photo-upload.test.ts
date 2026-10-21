import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePhoto, uploadPreparedPhoto } from '../miniprogram/services/v2/photo-upload';
import { call } from '../miniprogram/services/v2/client';
import { runtime } from '../miniprogram/config/runtime';
import { MAX_PHOTO_BYTES, PHOTO_TRANSPORT_BYTES, PHOTO_REQUEST_BYTES, jsonBytes, photoBytes } from '../miniprogram/domain/photo-limits';

let serial = 0;
async function fixture(work:(f:any)=>Promise<void>, originalBytes:number, compressed:number[]=[], rasterized:number[]=[]) {
  const g=globalThis as any, previous=g.wx, oldRuntime={...runtime};
  const files=new Map<string,string>([['/original',Buffer.alloc(originalBytes).toString('base64')]]);
  const compressions:any[]=[], exports:any[]=[], requests:any[]=[], cdn:any[]=[];
  const canvas:any={width:0,height:0,getContext:()=>({fillRect(){},drawImage(){}}),createImage:()=>{
    const image:any={};Object.defineProperty(image,'src',{set(){queueMicrotask(()=>image.onload());}});return image;
  }};
  let rejectSize=false, review=false, serverError='';
  runtime.mode='cloud';runtime.env='photo-transport-test-'+ ++serial;
  g.wx={getStorageSync:()=>review,getFileSystemManager:()=>({readFileSync:(path:string)=>files.get(path)}),
    compressImage:async(options:any)=>{
      compressions.push(options);const path='/compressed-'+compressions.length;
      files.set(path,Buffer.alloc(compressed[compressions.length-1] ?? originalBytes).toString('base64'));return {tempFilePath:path};
    },
    getImageInfo:async()=>({path:'/original',width:4000,height:3000}),
    createSelectorQuery:()=>({select(){return this;},fields(){return this;},exec(callback:any){callback([{node:canvas}]);}}),
    canvasToTempFilePath:async(options:any)=>{
      exports.push({...options});const path='/raster-'+exports.length;
      files.set(path,Buffer.alloc(rasterized[exports.length-1] ?? originalBytes).toString('base64'));return {tempFilePath:path};
    },
    cloud:{init(){},CDN(target:any){cdn.push(target);return {target};},async callFunction({data}:any){
      requests.push(data);
      if(rejectSize)throw {errMsg:'cloud.callFunction:fail Error: data exceed max size'};
      if(serverError)return {result:{ok:false,code:serverError}};
      return {result:{ok:true,data:{protocolVersion:2,epoch:'synthetic',resourceVersions:{workspace:1},data:{fileID:'synthetic-photo-id'}}}};
    }},
  };
  try {await work({files,compressions,exports,requests,cdn,canvas,rejectSize:()=>rejectSize=true,review:()=>review=true,serverError:(v:string)=>serverError=v,removeCDN:()=>delete g.wx.cloud.CDN});}
  finally {g.wx=previous;Object.assign(runtime,oldRuntime);}
}

test('1.6MiB照片压缩后走文件传输，云函数JSON不携带照片正文',async()=>fixture(async f=>{
  const photo=await preparePhoto('/original');
  assert.ok(photo.originalBytes<MAX_PHOTO_BYTES);
  assert.ok(f.files.get('/original').length>2*1024*1024,'编码后的原图已超过2MiB');
  assert.equal(photo.uploadedBytes,300*1024);assert.equal(photo.path,'/compressed-2');
  assert.deepEqual(f.compressions.map((x:any)=>x.src),['/original','/original']);
  await uploadPreparedPhoto(photo,'学期','任务');
  assert.equal(f.requests.length,1);
  assert.ok(Buffer.byteLength(JSON.stringify(f.requests[0]),'utf8')<=PHOTO_REQUEST_BYTES);
  assert.equal(f.requests[0].operation,'photoFile');
  assert.equal(f.requests[0].payload.base64,undefined);
  assert.deepEqual(f.cdn,[{type:'filePath',filePath:'/compressed-2'}]);
  assert.equal(f.requests[0].payload.photos,undefined);
},Math.floor(1.6*1024*1024),[900*1024,300*1024]));

test('小图保持原内容，不为压缩反而放大',async()=>fixture(async f=>{
  const photo=await preparePhoto('/original');
  assert.equal(photo.path,'/original');assert.equal(photo.uploadedBytes,100*1024);
  assert.equal(photo.base64,f.files.get('/original'));assert.equal(f.compressions.length,0);
},100*1024));

test('允许恰好5MiB原图，上传仍按传输预算压缩',async()=>fixture(async f=>{
  const photo=await preparePhoto('/original');
  assert.equal(photo.originalBytes,5*1024*1024);
  assert.equal(photo.uploadedBytes,300*1024);
  await uploadPreparedPhoto(photo,'semester','task');
  assert.equal(f.requests.length,1);
  assert.ok(jsonBytes(f.requests[0])<=PHOTO_REQUEST_BYTES);
},5*1024*1024,[300*1024]));

test('超过5MiB原图在上传前明确拒绝',async()=>fixture(async f=>{
  await assert.rejects(preparePhoto('/original'),/5MB以内/);
  assert.equal(f.compressions.length,0);assert.equal(f.requests.length,0);
},5*1024*1024+1));

test('PNG质量压缩无效时，降采样导出JPEG并测量实际字节',async()=>fixture(async f=>{
  const photo=await preparePhoto('/original');
  assert.equal(f.compressions.length,3);assert.equal(f.exports.length,2);
  assert.equal(f.exports[0].fileType,'jpg');assert.equal(f.exports[0].destWidth,2048);
  assert.equal(f.exports[0].destHeight,1536);assert.equal(photo.uploadedBytes,350*1024);
  assert.equal(photo.path,'/raster-2');assert.equal(f.canvas.width,1);
},1200*1024,[],[800*1024,350*1024]));

test('压缩仍超预算就停止，不发送已知过大的请求',async()=>fixture(async f=>{
  await assert.rejects(preparePhoto('/original'),/无法压缩到可传输大小/);
  assert.equal(f.requests.length,0);assert.equal(f.exports.length,6);
  assert.ok(f.exports.every((x:any)=>x.quality>=0.65 && x.destWidth>=1280));
},1500*1024));

test('检查整个UTF-8请求而非图片字段，拒绝绕过准备步骤的大请求',async()=>fixture(async f=>{
  for(const v of [{text:'姓名😀\n',plain:'abc'},{lone:'\ud800'}, {photo:f.files.get('/original')}])
    assert.equal(jsonBytes(v),Buffer.byteLength(JSON.stringify(v),'utf8'));
  await assert.rejects(call('photo',{payload:{base64:f.files.get('/original')}}),/传输数据过大/);
  assert.equal(f.requests.length,0);
  const base64=Buffer.alloc(PHOTO_TRANSPORT_BYTES).toString('base64');
  await assert.rejects(call('photo',{payload:{base64,note:'中'.repeat(40000)}}),/传输数据过大/);
  assert.equal(f.requests.length,0);
},Math.floor(1.6*1024*1024)));

test('若设备仍拒绝小请求，提示实测图片/请求体积而不指责原图超2MB',async()=>fixture(async f=>{
  f.rejectSize();
  await assert.rejects(uploadPreparedPhoto(await preparePhoto('/original'),'semester','task'),error=>{
    assert.match((error as Error).message,/图片100KB，请求\d+KB/);
    assert.doesNotMatch((error as Error).message,/base64|超过2MB|2MB以内/);return true;
  });
  assert.equal(f.requests.length,1);
},100*1024));

test('故障样本310KiB走文件通道，完整元数据小于16KiB，不再发送约413KiB正文',async()=>fixture(async f=>{
  const photo=await preparePhoto('/original');
  assert.equal(photo.uploadedBytes,310*1024);assert.equal(f.compressions.length,0);
  const result=await uploadPreparedPhoto(photo,'semester','task');
  assert.equal(result.data.fileID,'synthetic-photo-id');
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].payload.bytes,310*1024);
  assert.ok(jsonBytes(f.requests[0])<PHOTO_REQUEST_BYTES);
  assert.ok(!JSON.stringify(f.requests[0]).includes(photo.base64));
},310*1024));

test('审核体验不向CDN发送所选照片，继续使用内置示例',async()=>fixture(async f=>{
  f.review();const photo=await preparePhoto('/original');
  await uploadPreparedPhoto(photo,'review-semester','review-task');
  assert.equal(f.cdn.length,0);assert.equal(f.requests[0].operation,'photo');
  assert.ok(photoBytes(f.requests[0].payload.base64)<100);
  assert.notEqual(f.requests[0].payload.base64,photo.base64);
},310*1024));

test('不支持CDN或后端未更新时明确停止，不回退成已知失败的大JSON',async()=>fixture(async f=>{
  const photo=await preparePhoto('/original');f.serverError('UPGRADE_REQUIRED');
  await assert.rejects(uploadPreparedPhoto(photo,'semester','task'),/云端照片上传服务尚未更新/);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].payload.base64,undefined);
  f.removeCDN();await assert.rejects(uploadPreparedPhoto(photo,'semester','task'),/更新微信/);
  assert.equal(f.requests.length,1);
},310*1024));
