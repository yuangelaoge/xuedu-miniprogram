// 此入口由部署配置决定环境，不接受客户端传入环境或角色。
const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const { createGateway, freshDocument } = require("./generated/gateway.js");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const stage = "trial";
const collection = "xuedu_trial_workspace";
const gateway = createGateway({
  stage,
  appid: "wx5c7d4a458873c686",
  bootstrapOpenid: process.env.BOOTSTRAP_OPENID || "",
  uuid: () => crypto.randomUUID(),
  async transact(fn) {
    return db.runTransaction(async transaction => {
      const ref = transaction.collection(collection).doc("workspace");
      let doc;
      try { doc = (await ref.get()).data; }
      catch (e) {
        if (!/document.*not exist|document.*not found/i.test(e.message || "")) throw e;
      }
      if (!doc) doc = freshDocument(stage, crypto.randomUUID());
      if (!doc.state) throw new Error("云端数据格式异常，已停止写入，请联系管理员");
      delete doc._id;
      const before = JSON.stringify(doc);
      const result = await fn(doc);
      doc.state.actorId = "";
      if (before !== JSON.stringify(doc) || doc.version === 0) await ref.set({ data: doc });
      return result;
    });
  },
  async upload(cloudPath, base64) {
    const result = await cloud.uploadFile({ cloudPath, fileContent: Buffer.from(base64, "base64") });
    return result.fileID;
  },
  async deleteFiles(ids) {
    for (let i = 0; i < ids.length; i += 50) {
      const result = await cloud.deleteFile({ fileList: ids.slice(i, i + 50) });
      if (result.fileList.some(f => f.status !== 0 && !/not exist|not found/i.test(f.errMsg || ""))) throw new Error("部分照片删除失败，请重新预览范围并重试清理");
    }
  },
  async urls(ids) {
    if (!ids.length) return [];
    const result = await cloud.getTempFileURL({ fileList: ids.map(fileID => ({ fileID, maxAge: 300 })) });
    if (result.fileList.some(f => f.status !== 0)) throw new Error("照片暂时无法读取");
    return result.fileList.map(f => f.tempFileURL);
  },
});
exports.main = async event => {
  try { return { ok: true, data: await gateway(event, cloud.getWXContext()) }; }
  catch (error) { return { ok: false, error: error.message || "云端操作失败" }; }
};
