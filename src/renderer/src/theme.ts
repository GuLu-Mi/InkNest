import { computed, ref } from 'vue'
import type { ThemeChoice } from '../../shared/contracts'
const preference = ref<ThemeChoice>('system')
const system = window.matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(system.matches)
export const themeWarning = ref('')
export const darkTheme = computed(() => preference.value === 'dark' || (preference.value === 'system' && systemDark.value))
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
function apply(animate = false): void {
  const root = document.documentElement
  if (animate) { root.classList.add('theme-transition'); clearTimeout(timer); timer = setTimeout(() => root.classList.remove('theme-transition'), 240) }
  root.dataset.theme = darkTheme.value ? 'dark' : 'light'
}
system.addEventListener('change', event => { systemDark.value = event.matches; if (preference.value === 'system') apply(true) })
export async function initializeTheme(): Promise<void> {
  try { const result = await window.inknest.getTheme(); if (result.status !== 'ok') throw new Error(); preference.value = result.value.theme; themeWarning.value = result.value.warning }
  catch { themeWarning.value = '主题偏好无法读取，已跟随系统。' }
  apply()
}
export async function selectTheme(theme: 'light' | 'dark'): Promise<void> {
  const intent = ++sequence
  preference.value = theme; themeWarning.value = ''; apply(true)
  try {
    const result = await window.inknest.setTheme(theme)
    if (intent === sequence) themeWarning.value = result.status === 'ok' ? result.value.warning : '主题本次已生效，下次可能无法保留。请再次选择以重试。'
  } catch { if (intent === sequence) themeWarning.value = '主题本次已生效，下次可能无法保留。请再次选择以重试。' }
}
