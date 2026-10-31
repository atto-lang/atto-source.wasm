#ifndef ORESLANG_NATIVE_ERROR_SLOT_V1_H
#define ORESLANG_NATIVE_ERROR_SLOT_V1_H

#include <stdint.h>

#define ORES_ERROR_NONE_V1 0u
#define ORES_ERROR_ARITHMETIC_OVERFLOW_V1 65537u

#define ORES_EFFECT_NONE_V1 0u
#define ORES_EFFECT_THROW_V1 1u
#define ORES_EFFECT_RAISE_V1 2u
#define ORES_EFFECT_PANIC_V1 3u

typedef struct OresNativeErrorSlotV1 {
    uint32_t code;
    uint8_t effect;
    uint8_t flags;
    uint16_t reserved;
    uint64_t payload;
} OresNativeErrorSlotV1;

#if defined(__cplusplus)
static_assert(sizeof(OresNativeErrorSlotV1) == 16,
              "OresNativeErrorSlotV1 must remain 16 bytes");
#else
_Static_assert(sizeof(OresNativeErrorSlotV1) == 16,
               "OresNativeErrorSlotV1 must remain 16 bytes");
#endif

#endif
