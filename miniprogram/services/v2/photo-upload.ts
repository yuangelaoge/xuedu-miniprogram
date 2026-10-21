import { MAX_PHOTO_BYTES, PHOTO_TRANSPORT_BYTES, photoBytes } from '../../domain/photo-limits';
import { call, requestId, reviewActive } from './client';
import { runtime } from '../../config/runtime';

interface PreparedPhoto { path: string; base64: string; originalBytes: number; uploadedBytes: number; }
// Only retain the most recent failed attempt in memory. Reselecting the same
// prepared image can recover its receipt if the successful reply was lost.
let failedUpload: {scope:string;base64:string;id:string} | undefined;

/** File bytes bypass the cloud-function JSON transport, including on iOS. */
export async function uploadPreparedPhoto(photo: PreparedPhoto, semesterId: string, taskId: string, recordId?: string) {
  const options = {requestId:requestId(),semesterId};
  // Review uses a built-in illustration. Never transfer selected personal photos to CDN.
  if (reviewActive()) return call<{fileID:string}>('photo', {...options,payload:{taskId,recordId,base64:'cmV2aWV3'}});
  if (typeof wx.cloud.CDN !== 'function') throw new Error('当前微信版本不支持照片传输，请更新微信后重试');
  const scope = JSON.stringify([runtime.env,runtime.functionName,semesterId,taskId,recordId]);
  const attempt = failedUpload?.scope === scope && failedUpload.base64 === photo.base64
    ? failedUpload : {scope,base64:photo.base64,id:options.requestId};
  failedUpload = undefined;
  try {
    return await call<{fileID:string}>('photoFile', {...options,requestId:attempt.id,payload:{taskId,recordId,
      file:wx.cloud.CDN({type:'filePath',filePath:photo.path}),bytes:photo.uploadedBytes}});
  } catch (error) { failedUpload = attempt; throw error; }
}
function read(path: string) {
  const base64 = wx.getFileSystemManager().readFileSync(path,'base64');
  if (typeof base64 !== 'string' || !base64) throw new Error('无法读取照片，请重新选择');
  return {path,base64,bytes:photoBytes(base64)};
}

/** Enforce the source limit separately from the smaller storage budget. */
export async function preparePhoto(path: string): Promise<PreparedPhoto> {
  const original = read(path);
  if (original.bytes > MAX_PHOTO_BYTES) throw new Error('请选择1张5MB以内的照片');
  const result = (image: ReturnType<typeof read>) => ({path:image.path,base64:image.base64,originalBytes:original.bytes,uploadedBytes:image.bytes});
  if (original.bytes <= PHOTO_TRANSPORT_BYTES) return result(original);
  // Each attempt starts from the original, avoiding cumulative JPEG degradation.
  for (const quality of [80,65,50]) {
    try {
      const compressed = await wx.compressImage({src:path,quality});
      const image = read(compressed.tempFilePath);
      if (image.bytes <= PHOTO_TRANSPORT_BYTES) return result(image);
    } catch (_) { /* Some formats/devices do not support quality compression; rasterize below. */ }
  }
  // compressImage quality may have no effect on PNG. Export a bounded JPEG instead.
  const canvas = await new Promise<WechatMiniprogram.Canvas>((resolve,reject) => {
    wx.createSelectorQuery().select('#photo-upload-canvas').fields({node:true,size:true}).exec(rows => {
      if (!rows?.[0]?.node) reject(new Error('照片处理组件未就绪，请重新进入填写页'));
      else resolve(rows[0].node);
    });
  });
  const info = await wx.getImageInfo({src:path});
  if (!(info.width > 0 && info.height > 0)) throw new Error('无法读取照片尺寸，请重新选择');
  const image = canvas.createImage();
  await new Promise<void>((resolve,reject) => {
    const timer = setTimeout(()=>reject(new Error('照片处理超时，请重新选择')),15000);
    image.onload = () => {clearTimeout(timer);resolve();};
    image.onerror = () => {clearTimeout(timer);reject(new Error('照片无法解码，请重新选择'));};
    image.src = info.path;
  });
  try {
    for (const longest of [2048,1600,1280]) {
      const ratio = Math.min(1,longest / Math.max(info.width,info.height));
      const width = Math.max(1,Math.round(info.width*ratio)), height = Math.max(1,Math.round(info.height*ratio));
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';context.fillRect(0,0,width,height);
      context.drawImage(image,0,0,width,height);
      for (const quality of [0.8,0.65]) {
        const output = await wx.canvasToTempFilePath({canvas,width,height,destWidth:width,destHeight:height,fileType:'jpg',quality});
        const candidate = read(output.tempFilePath);
        if (candidate.bytes <= PHOTO_TRANSPORT_BYTES) return result(candidate);
      }
    }
  } finally {canvas.width=1;canvas.height=1;}
  throw new Error('照片仍无法压缩到可传输大小，请裁掉无关背景后重试；请保留清晰的老师签字');
}
