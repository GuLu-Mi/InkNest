<script setup lang="ts">
import { darkTheme, selectTheme, themeWarning } from '../theme'
function navigate(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const dark = event.key === 'End' || (event.key !== 'Home' && !darkTheme.value)
  void selectTheme(dark ? 'dark' : 'light')
  ;(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button')[dark ? 1 : 0]?.focus()
}
</script>
<template>
  <div class="theme-control">
    <div
      class="theme-switch"
      :class="{ 'is-dark': darkTheme }"
      role="radiogroup"
      aria-label="外观主题"
      @keydown="navigate"
    >
      <span
        class="theme-thumb"
        aria-hidden="true"
      />
      <button
        role="radio"
        aria-label="浅色主题"
        title="浅色主题"
        :aria-checked="!darkTheme"
        :tabindex="darkTheme ? -1 : 0"
        @click="selectTheme('light')"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><circle
          cx="12"
          cy="12"
          r="4"
        /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></svg>
      </button>
      <button
        role="radio"
        aria-label="深色主题"
        title="深色主题"
        :aria-checked="darkTheme"
        :tabindex="darkTheme ? 0 : -1"
        @click="selectTheme('dark')"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><path d="M20.2 15.6A8.7 8.7 0 0 1 8.4 3.8a8.7 8.7 0 1 0 11.8 11.8Z" /></svg>
      </button>
    </div>
    <p
      v-if="themeWarning"
      class="theme-warning"
      role="status"
    >
      {{ themeWarning }}
    </p>
  </div>
</template>
