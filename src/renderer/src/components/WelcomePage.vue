<script setup lang="ts">
import { copy } from '../../../shared/copy'
defineProps<{ busy: boolean; disabled: boolean }>()
defineEmits<{ open: [] }>()
</script>
<template>
  <main class="welcome-stage">
    <section
      class="welcome-card"
      aria-labelledby="welcome-heading"
    >
      <p class="welcome-brand">
        InkNest
      </p>
      <h1 id="welcome-heading">
        {{ copy.welcomeTitle }}
      </h1>
      <p class="intro">
        {{ copy.welcomeIntro }}
      </p>
      <button
        type="button"
        :disabled="busy || disabled"
        @click="$emit('open')"
      >
        {{ busy ? copy.opening : copy.openDocument }}
      </button>
      <p class="supported-files">
        {{ copy.supportedFiles }}
      </p>
    </section>
  </main>
</template>
