window.SHOWME = {
  skin: 'soft',
  kicker: '设计评审',
  title: '四条审计结论，各有两条修法',
  lead: '每条只有一件事要你决定：走 A 还是走 B。理由写在选项里，不用往下翻。',
  meta: ['4 条待定', 'review 形状', '约 2 分钟'],
  verdicts: ['同意', '要改', '不要'],
  sections: [
    {
      heading: '要你定走法',
      sub: '每条点一个就行',
      items: [
        {
          id: 'p0-3',
          title: '擦除约束漏了三列',
          desc: '两条 CHECK 各漏了字段，写了迁移也不等于擦干净。',
          preferred: 'A',
          options: [
            { value: 'A', label: '写迁移 0014，重定义两个 CHECK', why: '基线不动，改动只在一处；代价是一次数据回填要重跑校验。' },
            { value: 'B', label: '只登记进已知松点', why: '零风险，但擦除语义仍然是错的，下个人还得再查一遍。' }
          ]
        },
        {
          id: 'p0-4',
          title: 'accounts.role 没有外键',
          desc: '写进去的 role 可以根本不在 roles 表里。',
          options: [
            { value: 'A', label: '补一条加 FK 的迁移', why: '先核存量值全部合法再加，唯一真源的问题一次解决。' },
            { value: 'B', label: '把文档 8 处「已落」改回「未落」', why: '五分钟的事，先把谎话止住；数据库还是两个事实源。' }
          ]
        },
        {
          id: 'p1-2',
          title: 'hidden 渠道作品的详情页',
          desc: '预览路径已经对了，详情接口还漏判。',
          preferred: 'A',
          options: [
            { value: 'A', label: '详情 404', why: '§EN-1 的字面是「完全不可见」，404 与列表一致。' },
            { value: 'B', label: '200 但不给预览', why: '要给 DemoDetail 加 previewable 字段，前端多一处判断。' }
          ]
        },
        {
          id: 'p2-1',
          title: 'reports 表建了，文档说「不建」',
          desc: 'schema 里有 9 列，治理文档第 159 行写着本文不建。',
          options: [
            { value: 'A', label: '改文档，认下这张表', why: '代码已经在用，文档追代码最省事。' },
            { value: 'B', label: '删表，回到文档', why: '如果举报队列确实不打算有，那这张表就是提前搭的架子。' }
          ]
        }
      ]
    },
    {
      heading: '不用你决定的部分',
      items: [
        { id: 'ok-1', title: '迁移 0013 已跑过生产', desc: '这条只是通报，判定留给你的团队。' }
      ],
      blocks: [
        {
          type: 'kv',
          pairs: [
            ['受影响的 CHECK', 'ck_demos_erased / ck_rev_erased_content'],
            ['基线', '0013（不重写，只在 0014 上叠加）'],
            ['回填成本', '约 4 万行，单机 20 秒']
          ]
        }
      ]
    }
  ]
}
