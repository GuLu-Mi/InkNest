<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { copy } from '../../../shared/copy'
defineProps<{ outlineOpen: boolean }>()
const emit = defineEmits<{ outline: []; exit: [] }>()
const host = ref<HTMLElement>(); const visible = ref(true)
let timer: ReturnType<typeof setTimeout> | undefined
function reveal(): void {
  visible.value = true; clearTimeout(timer)
  timer = setTimeout(() => { if (!host.value?.contains(document.activeElement)) visible.value = false }, 3000)
}
onMounted(() => { window.addEventListener('pointermove', reveal); window.addEventListener('keydown', reveal); reveal() })
onBeforeUnmount(() => { clearTimeout(timer); window.removeEventListener('pointermove', reveal); window.removeEventListener('keydown', reveal) })
</script>
<template>
  <div
    ref="host"
    class="presentation-controls"
    :class="{ faded: !visible }"
    @focusin="reveal"
    @focusout="reveal"
  >
    <button
      aria-label="演示目录"
      :aria-expanded="outlineOpen"
      @click="emit('outline')"
    >
      目录
    </button>
    <button @click="emit('exit')">
      {{ copy.exitPresentation }}
    </button>
  </div>
</template>
