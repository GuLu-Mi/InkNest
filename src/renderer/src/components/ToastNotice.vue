<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps<{ notice: { message: string; sequence: number } | null }>()
const visible = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(() => props.notice, notice => {
  clearTimeout(timer)
  visible.value = !!notice
  if (notice) timer = setTimeout(() => { visible.value = false }, 2500)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))
</script>
<template>
  <Teleport to="body">
    <Transition name="toast">
      <p
        v-if="visible && notice"
        :key="notice.sequence"
        class="toast-notice"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ notice.message }}
      </p>
    </Transition>
  </Teleport>
</template>
<style scoped>
.toast-notice { position: fixed; z-index: 1000; bottom: 24px; left: 50%; transform: translateX(-50%); width: max-content; max-width: min(480px, calc(100vw - 32px)); margin: 0; padding: 10px 16px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--surface); color: var(--text-primary); box-shadow: 0 4px 18px rgb(0 0 0 / 15%); pointer-events: none; overflow-wrap: anywhere; }
.toast-enter-active, .toast-leave-active { transition: opacity 120ms ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .toast-enter-active, .toast-leave-active { transition: none; } }
</style>
