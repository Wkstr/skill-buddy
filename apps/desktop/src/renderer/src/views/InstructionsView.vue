<script setup lang="ts">
import InstructionWorkspace from '@/components/instructions/InstructionWorkspace.vue'

defineProps<{ inset?: boolean }>()
</script>

<template>
  <InstructionWorkspace :inset="inset" />
</template>
