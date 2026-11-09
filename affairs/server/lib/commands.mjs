export function commandCard(command = "affair", id = "<编号>") {
  return [
    "中文一律 --said - 或 --file，命令行上只写编号和开关。细节用 help <命令>。",
    `${command} brief ${id} --chat：每轮先读新的事。`,
    `${command} note ${id} --mine --file F：记一句结论（≤120 字），不改现在。`,
    `${command} report ${id} --from chat --file F.json：交回状态、记住的、问题或办完。`,
    `${command} answer <问题编号>：取这一轮他最新那句话答；可用 --said-seq 指定。`,
    `${command} flow ${id} [流程] [--resume|--trial] [--again]：他点名才起，一句话只起一次。`,
    `${command} pause ${id} --until T / stop ${id} / resume ${id} / undo ${id}：照他说的办。`,
    `${command} history ${id} [--q 词]：找以前的一问一答。`,
    `${command} renew ${id}：他说「换个新对话」才跑，这一轮说完换新。`,
    `${command} save ${id} [--msg-file F]：保存 README 和同文件夹的文档。`,
    `${command} here [--cwd D] / attach ${id}：从项目进来接手一件事。`,
    `${command} mode ${id} watch|drive --said-seq N：按他的原话切换盯或推。`,
    `${command} budget ${id} USD [--until YYYY-MM-DD] --said-seq N：记他批的额度。`,
    `${command} ask ${id} --file F.json：带选项、推荐和理由请他拍板。`,
    `${command} dispatch ${id} --contract F --provider P：核额度，取 MCP 派活参数。`,
    `${command} env ${id} [--remove]：搭建或拆掉代码环境。`,
    `${command} help [命令]：命令卡或完整用法。`,
  ].join("\n");
}

const usage = {
  mode: "mode <编号> watch|drive --said-seq N：只有他说过的原话能切换。推的事不排看一眼，切回盯才恢复。",
  budget: "budget <编号> <美元> [--until YYYY-MM-DD] --said-seq N：数字、截止日必须在他那句原话里；额度是累计上限，重新批不会清零花费。",
  ask: 'ask <编号> --file F.json：{title,line,options:[选项,...],recommend:选项,why:理由,push?:true,budget?:true}。budget:true 是额度卡：至少一个选项写明金额（如「批准，额度 $3」），他点了那个选项就记为批准的额度，不用再说一遍。只有当前主对话和 attach 过的会话能开；看一眼走 report。',
  dispatch: "dispatch <编号> --contract F [--provider p/model] [--thinking T] [--mode M] [--title T] [--cwd D]：只有推事项的当前主对话可用，先批额度；只记录核对结果并返回参数，不创建会话。由主对话原样调用 Paseo MCP create_agent，保留事项标签和 notifyOnFinish:true；创建时再次核额度，daemon 发最终完成通知。title 缺省用契约文件名（去扩展名）。指定目录时先建工作区。",
  env: "env <编号> [--remove]：每个 git 项目在主检出同级建 affair/<编号> 工作树，联接已有依赖，不安装；svn 副本问他。拆时先拆目录联接，未合并分支保留。",
  new: "new --title T [--id short-name] [--goal G] [--said -|--file F] [--link kind:ref（可多次）] [--project key（可多次）] [--domain personal|family] [--deadline T] [--role R] [--no-wait]\n没有单号关联时必须给 --id：2–40 个小写字母、数字或连字符，字母开头。",
  note: "note <编号|名字> --said -|--file F [--deadline T]\nnote <编号> --mine --said -|--file F [--said-seq N]\n对话和 attach 的会话用 --mine，≤120 字；这是自己的结论，不是他说的话，也不改现在。",
  answer: "answer <问题编号> [--said -|--file F] [--said-seq N]\n本人给原话；主对话默认取这一轮最新原话，必须在问题出现以后，不能替他编答案。",
  report: 'report <编号> --file F.json|--stdin [--from chat]\nJSON：{status, entry, facts:[], drop:[], next:{at,waitingFor,waitingOn,why,earlyIf:[],evidence:[{quote,from}],remind,appeal}, watches:[], ask:{title,line,options:[]}, finish:{kind:"done|stop",summary,evidence:{quote,from}}}\n主对话先 brief --chat，再 --from chat；每项可省，facts 新增、drop 删旧；不用 watches。看一眼的 facts 整组替换，entry ≤32 字（40 字以上拒绝），status ≤40 字。next 必须是未来的本地时间，引用出处用 said:N、answer:问题编号、reader:rN；finish 必须带证据，不带 next。拒绝时只补指出的字段，最多三次。',
  flow: "flow <编号> [流程] [--said-seq N] [--again] [--resume|--trial]\n不写流程列出可起及可续。默认取这一轮他最新一句，一句只能起一次；--again 从头新起，--resume 按真实续跑点继续；--trial 只在他明确试跑时新起使用。模板通知不能授权再起。",
  pause: "pause <编号|名字> --until \"YYYY-MM-DD HH:mm\" [--said -|--file F] [--said-seq N]\n主对话默认用这一轮最新的话；远于上限必须有他明说日期的原话。",
  stop: "stop <编号|名字> [--said -|--file F]：他说不用盯了才停，并收起事项文档。",
  resume: "resume <编号|名字>：重新盯，取回办完前的文档。",
  renew: "renew <编号>：他说要换个新对话时跑；这一轮结束后插件开新对话、带上最近几轮，旧的收起。不会自己换。",
  undo: "undo <编号|名字>：撤他十分钟内的上一句。",
  brief: "brief <编号> [--chat]：看一眼读完整现场，主对话只读上次以来新的。",
  history: "history <编号> [--q 词] [--pick N] [--max 字数]：按他当时的提问找以前的一问一答。",
  read: "read <工具> [--args JSON|--args -] [--for 编号]：只读外部数据；加 --for 才能以 reader:rN 作证据。",
  link: "link <编号> add|rm <kind:ref>：第一个是主关联；同一关联只属于一件在盯的事。",
  project: "project <编号> add|rm <remote:host/path|svn:host/path|path:hostname:absolute-path>：记涉及的项目。",
  save: "save <编号> [--msg-file F]：只提交这件事的文件夹并推送；README 建议 ≤4 KB，status ≤2 KB，对话手册合计 ≤4 KB。",
  here: "here [--cwd D]：列出这个项目上在进行的事。",
  attach: "attach <编号>：打印 status 和 README，绑定调用方；之后可 note --mine 和 ask，不能派活或批额度。看一眼不能 attach。",
  find: "find <词|kind:ref>：按编号、标题或关联定位在盯的事。",
  show: "show <编号|名字> [--log]：看进展或完整经过。",
  ls: "ls：列出在盯的事。", stats: "stats：查看花费。", doctor: "doctor：检查实际 policy、环境、文档大小和推送故障。",
  "pause-all": "pause-all：回退用，停全部计划并记下。", "resume-all": "resume-all：恢复之前暂停的计划。",
};
export function help(command = "") {
  return command ? { ok: Boolean(usage[command]), text: usage[command] || `没有这个命令：${command}` } : { ok: true, text: `${commandCard()}\n\n其他命令：new find link project show ls stats doctor read pause-all resume-all\n全局：--root D --paseo-home D --policy F --json` };
}
