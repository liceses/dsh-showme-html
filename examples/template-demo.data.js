/**
 * showme-report 模板示例 —— 这是一份**数据文件**，不是页面。
 *
 * 它演示了用模板要写的东西有多少：只有这个对象。
 * 交互（点选、组句、postMessage、可抄兜底）全在 templates/core.js 里，一行都不用重写。
 *
 * 文件名必须和页面同名：template-demo.html ↔ template-demo.data.js
 */
window.SHOWME = {
  // 皮肤：一行就能换 soft / swiss / brutal / blueprint
  skin: 'swiss',

  kicker: 'SHOWME-REPORT · 模板',
  title: '一页只有数据是你要写的',
  lead: '三个模板、一份内核。控件长在每一项自己旁边，点一下回执就实时交给卡片——不用你抄。',
  meta: ['3 个模板', '1 份内核', '控件与对象同屏'],

  sections: [
    {
      heading: '模板把「实现」变成了「填数据」',
      sub: '这就是做模板的理由',
      intro: '以前每一页都要模型重新实现一遍回执：控件放哪、怎么组句、什么时候发消息——反复出错。现在这些都在内核里写死了。',
      two: true,
      items: [
        {
          id: 'tpl-review',
          title: 'review · 逐项表态',
          desc: '最常用。一排条目，每条一个判定 + 备注。带图不带图都行。',
        },
        {
          id: 'tpl-pick',
          title: 'pick · 从候选里挑',
          desc: '单选或多选。比如"封面用哪一张""这几张素材留哪几个"。',
        },
        {
          id: 'tpl-report',
          title: 'report · 图文汇报',
          desc: '有图、有表、有时间线，不需要逐项表态的场景；每小节给一个轻回执。',
        },
        {
          id: 'tpl-core',
          title: 'core.js · 三个模板共用的一份内核',
          desc: '交互逻辑只写一遍。上一次我把 dsh-text-drop 的 bug 抄了过来——同一个错误不该有两份。',
        },
      ],
      blocks: [
        {
          type: 'callout',
          label: '怎么用',
          text: 'cp 一个模板 → 写同名数据文件 → show_html。模型只写数据，几百 token；不用读模板、不用重写交互。',
        },
      ],
    },
    {
      heading: '控件长在它指的每一样东西旁边',
      sub: 'skill §3.2 —— 用户做判定时，对象和控件必须同屏',
      items: [
        {
          id: 'demo-image-item',
          title: '带图也一样：图有 max-height:60vh',
          desc: '图太高会导致"看图时看不到控件、滚到控件又看不到图"。内核给图限了高，并且控件就在它下面这张卡片里。',
          image: 'assets/arch.svg',
          caption: '图 1 · 相对路径引用，靠镜像路由服务',
        },
      ],
    },
    {
      heading: '这一页本身就是 review 模板渲染的',
      sub: '你现在点上面每一个判定，右下角那段文本都会实时变',
      items: [
        {
          id: 'verdict-live',
          title: '试试点一下「同意」',
          desc: '组句是 <id> <判定词>[：备注]，一行一条。每次变化都会 postMessage 给卡片——卡片上会出现「填入输入框」。',
        },
        {
          id: 'verdict-note',
          title: '再写一句备注',
          desc: '备注会跟在判定词后面，用全角冒号隔开：verdict-note 要改：这里写什么都行。',
        },
      ],
    },
  ],
}
