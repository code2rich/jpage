// 即页「无权操作」诊断脚本
// 用法：node diagnose.js <服务器地址> <账号> <密码> [文件ID]
// 例：  node diagnose.js http://36.138.227.105:8858 code2rich 你的密码 22
const store = {};
global.utools = {
  dbStorage: { getItem:(k)=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=v}, removeItem:(k)=>{delete store[k]} },
  shellOpenExternal(){}, copyText(){}, showOpenDialog(){return null}
};
global.window = {};
require('./preload.js');
const jpage = global.window.jpage;

(async () => {
  const [,, base, account, password, fileIdArg] = process.argv;
  if (!base || !account || !password) {
    console.log('用法: node diagnose.js <服务器地址> <账号> <密码> [文件ID]');
    process.exit(1);
  }
  jpage.setBase(base);

  console.log('=== 1. 登录 ===');
  let user;
  try { user = await jpage.login({ account, password }); }
  catch (e) { console.log('✗ 登录失败:', e.message); process.exit(1); }
  console.log('登录用户:', JSON.stringify({ id: user.id, username: user.username, role: user.role }));

  console.log('\n=== 2. 文件列表（看 uploaded_by）===');
  const list = await jpage.listFiles({ limit: 5 });
  console.log('前5个文件:');
  list.files.forEach(f => {
    const mine = Number(f.uploaded_by) === Number(user.id) ? '✓我的' : '✗非我';
    console.log(`  id:${f.id} | uploaded_by:${f.uploaded_by} | ${mine} | ${f.original_name}`);
  });

  // 选一个目标文件测试
  const targetId = fileIdArg ? Number(fileIdArg) : (list.files[0] && list.files[0].id);
  const target = list.files.find(f => Number(f.id) === Number(targetId));
  console.log(`\n=== 3. 测试文件 id:${targetId} ===`);
  if (target) {
    console.log('  uploaded_by:', target.uploaded_by, '| 我的id:', user.id, '| 是我的:', Number(target.uploaded_by)===Number(user.id));
  }

  console.log('\n=== 4. 尝试打标签（复现 403）===');
  // 先建一个标签
  let tagId;
  try {
    const tag = await jpage.createTag('诊断测试标签');
    tagId = tag.id;
    console.log('  建标签成功, id:', tagId);
  } catch (e) {
    console.log('  建标签失败:', e.message, '（用已有标签重试）');
    const tags = await jpage.listTags();
    tagId = tags.tags[0] && tags.tags[0].id;
  }
  if (tagId) {
    try {
      await jpage.setFileTags(targetId, [tagId]);
      console.log('  ✓ 打标签成功！');
    } catch (e) {
      console.log('  ✗ 打标签失败:', e.message, '| status:', e.status);
      console.log('  → 结论: 服务端 req.userId 或 req.userRole 与预期不符');
    }
  }

  console.log('\n=== 5. 尝试设分类（复现 403）===');
  try {
    await jpage.setFileCategory(targetId, null);
    console.log('  ✓ 设分类成功（设为空）！');
  } catch (e) {
    console.log('  ✗ 设分类失败:', e.message, '| status:', e.status);
  }

  console.log('\n=== 6. 尝试改文件名（同一套 ownership 校验）===');
  if (target) {
    try {
      await jpage.updateFile(targetId, { name: target.original_name }); // 改成原名，不应有变化
      console.log('  ✓ 改名成功！');
    } catch (e) {
      console.log('  ✗ 改名失败:', e.message, '| status:', e.status);
    }
  }

  console.log('\n诊断完成。请把以上输出全部发给我。');
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
