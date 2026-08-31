<script setup lang="ts">
import { computed, shallowRef, type HTMLAttributes } from 'vue'
import { Check, ChevronDown, Search } from '@lucide/vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxVirtualizer,
} from 'reka-ui'
import { cn } from '@/lib/utils'

export interface VirtualSelectOption {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  options: VirtualSelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  class?: HTMLAttributes['class']
}>(), {
  placeholder: '',
  searchPlaceholder: 'Search',
  emptyText: 'No options found',
  disabled: false,
  class: '',
})
const model = defineModel<string>()
const open = shallowRef(false)
const search = shallowRef('')

const selectedOption = computed(() => props.options.find((option) => option.value === model.value))
const filteredOptions = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  if (!query) return props.options
  return props.options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query)
    || option.value.toLocaleLowerCase().includes(query),
  )
})

function updateOpen(value: boolean): void {
  open.value = value
  search.value = ''
}

function emptyDisplayValue(): string {
  return ''
}
</script>

<template>
  <ComboboxRoot
    v-model="model"
    :open="open"
    :disabled="props.disabled"
    :ignore-filter="true"
    @update:open="updateOpen"
  >
    <ComboboxAnchor as-child>
      <ComboboxTrigger
        :aria-label="props.placeholder"
        :class="cn(
          'flex h-8 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background py-1 pl-2.5 pr-2 text-sm transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          props.class,
        )"
      >
        <span
          :class="['min-w-0 flex-1 truncate text-left', !selectedOption && 'text-muted-foreground']"
          :title="selectedOption?.label"
        >
          {{ selectedOption?.label ?? props.placeholder }}
        </span>
        <ChevronDown
          :class="['size-3.5 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-180']"
        />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        align="start"
        :side-offset="4"
        class="z-[70] w-[var(--reka-combobox-trigger-width)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none"
      >
        <div class="relative border-b">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <ComboboxInput
            v-model="search"
            :display-value="emptyDisplayValue"
            :placeholder="props.searchPlaceholder"
            :spellcheck="false"
            class="h-9 w-full bg-transparent pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div class="virtual-select-options max-h-72 overflow-y-auto p-1">
          <div
            v-if="filteredOptions.length === 0"
            class="px-2 py-6 text-center text-sm text-muted-foreground"
          >
            {{ props.emptyText }}
          </div>
          <ComboboxVirtualizer
            v-else
            v-slot="{ option }"
            :options="filteredOptions"
            :estimate-size="32"
            :overscan="8"
            :text-content="(option) => option.label"
          >
            <ComboboxItem
              :value="option.value"
              :text-value="option.label"
              class="relative flex h-8 w-full cursor-pointer select-none items-center rounded-[5px] py-1.5 pl-2.5 pr-8 text-sm outline-none data-[highlighted]:bg-accent"
            >
              <span
                class="min-w-0 flex-1 truncate"
                :title="option.label"
              >
                {{ option.label }}
              </span>
              <Check
                v-if="model === option.value"
                class="absolute right-2 size-3.5"
              />
            </ComboboxItem>
          </ComboboxVirtualizer>
        </div>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<style scoped lang="scss">
.virtual-select-options {
  scrollbar-color: var(--scrollbar-thumb) transparent;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    background-clip: padding-box;
    border: 2px solid transparent;
    border-radius: 999px;
  }
}
</style>
