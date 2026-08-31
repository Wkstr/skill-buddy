<script setup lang="ts">
import { CircleHelp, TriangleAlert } from '@lucide/vue'
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from 'reka-ui'
import { Button } from '@/components/ui/button'
import { useConfirmHost } from '@/composables/useConfirm'

const { confirm, respond } = useConfirmHost()
</script>

<template>
  <AlertDialogRoot
    :open="confirm !== null"
    @update:open="(open) => !open && respond(false)"
  >
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 z-[60] bg-black/40" />
      <AlertDialogContent
        class="fixed left-1/2 top-1/2 z-[61] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-5 shadow-xl outline-none"
      >
        <div class="flex gap-3">
          <span
            :class="[
              'flex size-9 shrink-0 items-center justify-center rounded-full',
              confirm?.danger ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
            ]"
          >
            <TriangleAlert
              v-if="confirm?.danger"
              class="size-4"
            />
            <CircleHelp
              v-else
              class="size-4"
            />
          </span>
          <div class="min-w-0 flex-1">
            <AlertDialogTitle class="text-base font-semibold">
              {{ confirm?.title }}
            </AlertDialogTitle>
            <AlertDialogDescription class="mt-1.5 whitespace-pre-line text-sm text-muted-foreground">
              {{ confirm?.message }}
            </AlertDialogDescription>
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialogCancel as-child>
            <Button
              variant="ghost"
              size="sm"
              class="cursor-pointer"
            >
              {{ confirm?.cancelLabel }}
            </Button>
          </AlertDialogCancel>
          <!--
            确认按钮不包 AlertDialogAction：它自带的关闭会先触发 update:open(false)，
            让结果被改写成取消。这里由 respond 单向驱动关闭，顺序才是确定的。
          -->
          <Button
            size="sm"
            class="cursor-pointer"
            :variant="confirm?.danger ? 'destructive' : 'default'"
            @click="respond(true)"
          >
            {{ confirm?.confirmLabel }}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
