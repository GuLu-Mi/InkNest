<script setup lang="ts">
defineProps<{ name: 'outline' | 'file' | 'save' | 'chevron' | 'play' | 'history' | 'pending' | 'saved' | 'error' | 'saving' }>()
const paths = {
  outline: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm4 0v18',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h8',
  save: 'M5 3h12l4 4v14H3V3h2Zm2 0v6h10V3M7 21v-8h10v8M14 4v3',
  chevron: 'm6 9 6 6 6-6',
  play: 'm6 3 15 9-15 9V3Z',
  history: 'M3 11a9 9 0 1 1 2.5 7.2M3 4v7h7m2-4v5l3 2',
  pending: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  saved: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM8 12l3 3 5-6',
  error: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 7v6m0 4h.01',
  saving: 'M22 12a10 10 0 1 1-10-10',
} as const
</script>
<template>
  <svg
    class="document-icon"
    :class="{ 'is-saving': name === 'saving' }"
    viewBox="0 0 24 24"
    aria-hidden="true"
  ><path :d="paths[name]" /></svg>
</template>
