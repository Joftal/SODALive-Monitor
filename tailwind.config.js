/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 主色与状态色: 全部走 styles.css 的语义变量, .dark 下整体换值
        // (旧配置里 brand 与 live 同为 #fb7299, 一个色值兼「应用主题色 / Panda 平台身份 / 在播状态」三重语义, 已拆分)
        brand: {
          DEFAULT: 'rgb(var(--c-brand) / <alpha-value>)',
          hi: 'rgb(var(--c-brand-hi) / <alpha-value>)'
        },
        // live 只做色点/图标/进度条(3.91:1, 不达标正文); 承载文字一律用 liveink(6.52:1)
        live: 'rgb(var(--c-live) / <alpha-value>)',
        liveink: 'rgb(var(--c-live-ink) / <alpha-value>)',
        ok: 'rgb(var(--c-ok) / <alpha-value>)',
        okink: 'rgb(var(--c-ok-ink) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        warnink: 'rgb(var(--c-warn-ink) / <alpha-value>)',
        warnbg: 'rgb(var(--c-warn-bg) / <alpha-value>)',
        // 语义化中性调色板: 由 CSS 变量驱动
        page: 'rgb(var(--c-page) / <alpha-value>)',
        card: 'rgb(var(--c-card) / <alpha-value>)',
        ink1: 'rgb(var(--c-ink1) / <alpha-value>)',
        ink2: 'rgb(var(--c-ink2) / <alpha-value>)',
        ink3: 'rgb(var(--c-ink3) / <alpha-value>)',
        deco: 'rgb(var(--c-deco) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        fill: 'rgb(var(--c-fill) / <alpha-value>)',
        fillh: 'rgb(var(--c-fillh) / <alpha-value>)',
        // 图上徽标底(设计稿 3.3 R1 的两种承载面之一): 深浅主题各一档, 不再各处手写 bg-black/55|60
        onimg: 'var(--tag-onimg)',
        // 暗场(播放器遮罩 / 影院浮层)专用亮红: 黑底上的错误文字与危险控件
        errdark: 'rgb(var(--c-err-dark) / <alpha-value>)'
      },
      borderRadius: {
        card: '14px', // 卡片
        ctl: '10px' // 按钮/输入框等控件
      },
      boxShadow: {
        card: '0 1px 2px var(--shadow-card)',
        'card-hover': '0 6px 20px var(--shadow-card-hover)'
      },
      keyframes: {
        breathe: {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '.45' }
        }
      },
      animation: {
        breathe: 'breathe 1.6s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
