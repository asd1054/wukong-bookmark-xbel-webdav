// 悟空书签同步xbel-ByWebdav - 后台最小化（仅用于未来定时同步）
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('sync', { periodInMinutes: 60 });
});
chrome.alarms.onAlarm.addListener(() => {
  // 目前仅手动同步，定时功能留待以后
  console.log('悟空书签同步xbel-ByWebdav - 定时心跳');
});