window.__ModuleLoader__.load({
  id: 'dsh-tavern-rewrite',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const PLUGIN = 'dsh-tavern-rewrite'
    const DISCORD = 'https://discord.com/channels/1134557553011998840/1553427579346616480'

    const STATUS_LABEL = {
      prepared: '已准备',
      ready: '已替换',
      skipped: '跳过',
      failed: '失败',
      cancelled: '取消'
    }
    const SOURCE_LABEL = {
      credentials: '凭据'
    }
    const REASON_LABEL = {
      'off-topic': '偏离原文',
      'new-content': '掺入新内容',
      'new-heading': '新增标题',
      'too-long': '过长',
      'too-short-output': '过短',
      'no-change': '原样返回',
      repetition: '复读',
      truncated: '截断',
      placeholder: '标记丢失',
      input_too_short: '太短',
      input_too_long: '太长',
      model_not_found: '模型不存在',
      empty: '空结果',
      short: '太短',
      structure: '结构校验'
    }

    const styles = {
      panel: { display: 'grid', gap: '12px', padding: '2px', fontSize: '13px', lineHeight: 1.55 },
      hint: { color: 'var(--dsh-text-secondary, #8a8a8a)', fontSize: '12px' },
      label: { display: 'grid', gap: '4px', color: 'var(--dsh-text-secondary, #8a8a8a)' },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '6px',
        border: '1px solid rgba(127,127,127,.35)', background: 'transparent',
        color: 'inherit', font: 'inherit'
      },
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      button: {
        padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(127,127,127,.35)',
        background: 'rgba(127,127,127,.08)', color: 'inherit', cursor: 'pointer', font: 'inherit'
      },
      buttonPrimary: {
        padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(120,170,255,.6)',
        background: 'rgba(120,170,255,.16)', color: 'inherit', cursor: 'pointer', font: 'inherit'
      },
      error: { color: '#e5534b', fontSize: '12px', whiteSpace: 'pre-wrap' },
      notice: { color: '#3fb950', fontSize: '12px', whiteSpace: 'pre-wrap' },
      warn: { color: '#d9a100', fontSize: '12px', padding: '6px 8px', borderRadius: '6px', background: 'rgba(217,161,0,.12)', whiteSpace: 'pre-wrap' },
      sectionTitle: { fontWeight: 600, marginTop: '4px' },
      log: { display: 'grid', gap: '4px', maxHeight: '240px', overflow: 'auto' },
      logRow: {
        display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '8px', alignItems: 'baseline',
        padding: '4px 6px', borderRadius: '4px', background: 'rgba(127,127,127,.06)', fontSize: '12px'
      },
      check: { display: 'flex', gap: '7px', alignItems: 'center', cursor: 'pointer' },
      link: { color: '#58a6ff', textDecoration: 'none' },
      badge: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '2px 8px',
        borderRadius: '999px', background: 'rgba(127,127,127,.12)', fontSize: '12px',
        color: 'var(--dsh-text-secondary, #8a8a8a)'
      },
      dot: { width: '6px', height: '6px', borderRadius: '999px', background: '#d9a100', display: 'inline-block' }
    }

    function formatTime(value) {
      const date = new Date(Number(value) || Date.now())
      return date.toLocaleTimeString('zh-CN', { hour12: false })
    }

    function Panel({ ctx, gameId }) {
      const [state, setState] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [apiKey, setApiKey] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [loading, setLoading] = React.useState(true)

      function applyState(next) {
        if (!next) return
        setState(next)
        setForm({
          auto: next.settings.auto !== false,
          baseURL: next.settings.baseURL,
          model: next.settings.model,
          temperature: String(next.settings.temperature),
          maxChars: String(next.settings.maxChars),
          concurrency: String(next.settings.concurrency)
        })
      }

      async function refresh() {
        setLoading(true)
        setError('')
        try {
          applyState(await ctx.tavernUi.callHost(PLUGIN + '/state', {}))
        } catch (reason) {
          setError(String(reason?.message || reason))
        } finally {
          setLoading(false)
        }
      }

      React.useEffect(() => { void refresh() }, [])

      function update(field, value) {
        setForm(current => ({ ...(current || {}), [field]: value }))
      }

      async function save() {
        setBusy('save')
        setError('')
        setNotice('')
        try {
          const next = await ctx.tavernUi.callHost(PLUGIN + '/save', { settings: form })
          applyState(next)
          setNotice('设置已保存')
        } catch (reason) {
          setError(String(reason?.message || reason))
        } finally {
          setBusy('')
        }
      }

      async function saveKey(clear) {
        if (!clear && !apiKey.trim()) { setError('先填一个 API 密钥'); return }
        setBusy(clear ? 'clear' : 'key')
        setError('')
        setNotice('')
        try {
          const next = await ctx.tavernUi.callHost(PLUGIN + '/key', { apiKey: clear ? '' : apiKey })
          setState(current => current ? { ...current, key: next.key } : current)
          if (!clear) setApiKey('')
          setNotice(clear ? '已清除凭据里的密钥' : '密钥已保存')
        } catch (reason) {
          setError(String(reason?.message || reason))
        } finally {
          setBusy('')
        }
      }

      async function setAuto(checked) {
        update('auto', checked)
        setBusy('auto')
        setError('')
        setNotice('')
        try {
          const next = await ctx.tavernUi.callHost(PLUGIN + '/save', { settings: { auto: checked } })
          setState(current => current ? { ...current, settings: next.settings } : current)
          setNotice(checked ? '已开启自动润色' : '已关闭自动润色')
        } catch (reason) {
          update('auto', !checked)
          setError(String(reason?.message || reason))
        } finally {
          setBusy('')
        }
      }

      async function test() {
        setBusy('test')
        setError('')
        setNotice('')
        try {
          const result = await ctx.tavernUi.callHost(PLUGIN + '/test', {})
          const models = Array.isArray(result?.models) ? result.models.join('、') : ''
          setNotice('连接成功' + (models ? '：' + models : ''))
          if (result?.models?.length && !result.models.includes(result.model)) {
            setError('当前模型 ' + result.model + ' 不在服务返回的列表里，仍可尝试润色')
          }
        } catch (reason) {
          setError(String(reason?.message || reason))
        } finally {
          setBusy('')
        }
      }

      async function polish() {
        if (!gameId) { setError('先打开一局游戏'); return }
        setBusy('polish')
        setError('')
        setNotice('')
        try {
          const turnState = await ctx.tavernUi.getTurnState(gameId)
          if (!turnState?.settled || turnState.busy) throw new Error('这一轮还在生成或结算，请稍后再试')
          await ctx.tavernUi.callHost(PLUGIN + '/polish', { gameId, turn: turnState.turn })
          setNotice('这一轮已经重新润色')
          await refresh()
        } catch (reason) {
          setError(String(reason?.message || reason))
        } finally {
          setBusy('')
        }
      }

      if (loading && !form) return h('div', { style: styles.panel }, h('div', { style: styles.hint }, '正在读取设置…'))
      if (!form) return h('div', { style: styles.panel }, h('div', { style: styles.error }, error || '读取设置失败'), h('button', { type: 'button', style: styles.button, onClick: refresh }, '重试'))

      const key = state?.key || { configured: false, source: '' }
      const recent = state?.recent || []
      const field = (label, input) => h('label', { style: styles.label }, label, input)

      return h('div', { style: styles.panel },
        h('div', null,
          h('div', { style: styles.sectionTitle }, 'revnovel润色'),
          h('div', { style: styles.hint }, '正文写完后自动调用 revnovel 改写一次，再替换成润色后的正文。HTML 状态栏、代码块、插件标记会原样保留；正文不足 400 字时自动跳过，单段超过 2000 字会先切段。')
        ),
        h('div', { style: styles.row },
          h('span', { style: styles.badge },
            h('span', { style: { ...styles.dot, background: key.configured ? '#3fb950' : '#e5534b' } }),
            key.configured ? '密钥已配置（' + (SOURCE_LABEL[key.source] || key.source) + '）' : '密钥未配置'
          ),
          h('label', { style: styles.check, title: '总开关；每局还能在本局设置里单独关闭' },
            h('input', { type: 'checkbox', checked: form.auto !== false, disabled: Boolean(busy), onChange: event => setAuto(event.target.checked) }),
            '自动润色'
          )
        ),
        error ? h('div', { style: styles.error }, error) : null,
        notice ? h('div', { style: styles.notice }, notice) : null,
        !key.configured ? h('div', { style: styles.warn }, '还没有配置 API 密钥：把 sk-rw-… 粘贴到下面并保存。') : null,
        h('div', { style: styles.row },
          h('div', { style: { flex: '1 1 260px' } }, field('服务地址', h('input', {
            style: styles.input, value: form.baseURL,
            onChange: event => update('baseURL', event.target.value),
            placeholder: 'https://rewrite.revnovel.org'
          }))),
          h('div', { style: { flex: '1 1 220px' } }, field('模型', h('input', {
            style: styles.input, value: form.model,
            onChange: event => update('model', event.target.value),
            placeholder: 'rewrite-v12-fp8'
          })))
        ),
        h('div', { style: styles.row },
          h('div', { style: { flex: '1 1 130px' } }, field('温度（0.5–0.8；太低会原样回显）', h('input', {
            style: styles.input, type: 'number', min: 0, max: 1, step: 0.05, value: form.temperature,
            onChange: event => update('temperature', event.target.value)
          }))),
          h('div', { style: { flex: '1 1 130px' } }, field('单段目标字数', h('input', {
            style: styles.input, type: 'number', min: 400, max: 2000, step: 50, value: form.maxChars,
            onChange: event => update('maxChars', event.target.value)
          }))),
          h('div', { style: { flex: '1 1 110px' } }, field('并发送稿数', h('input', {
            style: styles.input, type: 'number', min: 1, max: 4, step: 1, value: form.concurrency,
            onChange: event => update('concurrency', event.target.value)
          })))
        ),
        h('div', { style: styles.row },
          h('button', { type: 'button', style: styles.buttonPrimary, disabled: Boolean(busy), onClick: save }, busy === 'save' ? '保存中…' : '保存设置'),
          h('button', { type: 'button', style: styles.button, disabled: Boolean(busy), onClick: test }, busy === 'test' ? '测试中…' : '测试连接'),
          h('button', { type: 'button', style: styles.button, disabled: Boolean(busy) || !gameId, onClick: polish }, busy === 'polish' ? '润色中…' : '润色当前这一轮'),
          h('button', { type: 'button', style: styles.button, disabled: Boolean(busy), onClick: refresh }, '刷新')
        ),
        h('div', { style: styles.label }, 'API 密钥',
          h('div', { style: styles.row },
            h('input', {
              style: { ...styles.input, flex: '1 1 240px' }, type: 'password', value: apiKey,
              onChange: event => setApiKey(event.target.value),
              placeholder: key.configured ? '已配置，留空不修改' : 'sk-rw-…',
              onKeyDown: event => { if (event.key === 'Enter') void saveKey(false) }
            }),
            h('button', { type: 'button', style: styles.button, disabled: Boolean(busy), onClick: () => saveKey(false) }, busy === 'key' ? '保存中…' : '保存密钥'),
            h('button', { type: 'button', style: styles.button, disabled: Boolean(busy) || !key.configured, onClick: () => saveKey(true) }, busy === 'clear' ? '清除中…' : '清除凭据里的密钥')
          ),
          h('span', { style: styles.hint }, '密钥保存在 DSH 凭据里。')
        ),
        h('div', { style: styles.sectionTitle }, '最近的润色'),
        recent.length
          ? h('div', { style: styles.log }, recent.map((entry, index) => h('div', { key: index, style: styles.logRow },
            h('span', { style: styles.hint }, formatTime(entry.at)),
            h('span', null,
              '第 ' + entry.turn + ' 轮 · ' + (entry.mode === 'manual' ? '手动' : '自动') + ' · ' +
              (STATUS_LABEL[entry.status] || entry.status) +
              (entry.stats ? '（' + entry.stats.polished + '/' + entry.stats.chunks + ' 段' + (entry.stats.reasons && entry.stats.reasons.length ? '，' + entry.stats.reasons.map(value => REASON_LABEL[value] || value).join('、') : '') + '）' : '') +
              (entry.reason ? ' · ' + entry.reason : '')
            ),
            h('span', { style: styles.hint }, entry.ms ? Math.round(entry.ms / 100) / 10 + 's' : '')
          )))
          : h('div', { style: styles.hint }, '还没有记录'),
        h('div', { style: styles.hint }, '作者 Discord：', h('a', { href: DISCORD, target: '_blank', rel: 'noreferrer noopener', style: styles.link }, '加入频道'))
      )
    }

    return {
      name: PLUGIN,
      inject: ['tavernUi'],
      apply(ctx) {
        if (!ctx.tavernUi || Number(ctx.tavernUi.apiVersion) < 2) return
        if (typeof ctx.tavernUi.registerMediaRenderer === 'function') {
          ctx.tavernUi.registerMediaRenderer(PLUGIN + '/status', ({ item }) => {
            if (item?.status === 'pending') {
              return h('span', { style: styles.badge }, h('span', { style: styles.dot }), item.caption || '润色中…')
            }
            if (item?.status === 'failed') {
              const reason = String(item.error || item.caption || '润色失败')
              return h('span', { style: { ...styles.badge, color: '#e5534b' } }, '润色失败：' + (reason.length > 120 ? reason.slice(0, 120) + '…' : reason))
            }
            return null
          })
        }
        if (typeof ctx.tavernUi.registerComposerAction === 'function') {
          ctx.tavernUi.registerComposerAction({
            id: 'polish',
            label: 'revnovel润色',
            when: ({ busy, turn }) => !busy && Number.isInteger(turn) && turn > 0,
            run: async ({ gameId, turn }) => {
              await ctx.tavernUi.callHost(PLUGIN + '/polish', { gameId, turn })
            }
          })
        }
        if (typeof ctx.tavernUi.registerPanel === 'function') {
          ctx.tavernUi.registerPanel({
            id: 'rewrite',
            title: 'revnovel润色',
            render: ({ gameId }) => h(Panel, { ctx, gameId })
          })
        }
      }
    }
  }
})
