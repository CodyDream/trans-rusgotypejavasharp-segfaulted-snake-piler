// sse_shim.h — parse-time SSE/AVX declarations for the Clang front-end.
//
// The bundled libclang 18.1.1 cannot parse GCC 14's intrinsic headers
// (GCC-14-only __builtin_ia32_* declarations). This shim:
//   1. Pre-defines the GCC include guards so the real intrin headers are skipped
//   2. Declares every _mm_* intrinsic used anywhere in Jolt, with true ABI
//      signatures (parse-only; the C++ ground truth build uses the real GCC
//      headers — this shim exists solely so the AST parses)
//   3. Defines _MM_SHUFFLE so Jolt's shuffle constants fold during parsing

#ifndef OURO_SSE_SHIM
#define OURO_SSE_SHIM

// Block GCC/MSVC intrinsic headers — we provide the declarations ourselves
#define _IMMINTRIN_H_INCLUDED
#define _X86INTRIN_H_INCLUDED
#define _IA32INTRIN_H_INCLUDED
#define _XMMINTRIN_H_INCLUDED
#define _EMMINTRIN_H_INCLUDED
#define _PMMINTRIN_H_INCLUDED
#define _TMMINTRIN_H_INCLUDED
#define _SMMINTRIN_H_INCLUDED
#define _NMMINTRIN_H_INCLUDED
#define _WMMINTRIN_H_INCLUDED
#define _MM_MALLOC_H_INCLUDED

typedef float    __m128  __attribute__((__vector_size__(16), __may_alias__));
typedef int      __m128i __attribute__((__vector_size__(16), __may_alias__));
typedef double   __m128d __attribute__((__vector_size__(16), __may_alias__));
typedef unsigned short __mmask16;

#define _MM_SHUFFLE(z, y, x, w) (((z) << 6) | ((y) << 4) | ((x) << 2) | (w))

// ---- float lanes (__m128) ----
extern __m128  _mm_add_ps(__m128, __m128);
extern __m128  _mm_sub_ps(__m128, __m128);
extern __m128  _mm_mul_ps(__m128, __m128);
extern __m128  _mm_div_ps(__m128, __m128);
extern __m128  _mm_min_ps(__m128, __m128);
extern __m128  _mm_max_ps(__m128, __m128);
extern __m128  _mm_and_ps(__m128, __m128);
extern __m128  _mm_or_ps(__m128, __m128);
extern __m128  _mm_xor_ps(__m128, __m128);
extern __m128  _mm_andnot_ps(__m128, __m128);
extern __m128  _mm_set1_ps(float);
extern __m128  _mm_setzero_ps(void);
extern __m128  _mm_set_ss(float);
extern __m128  _mm_set_ps(float, float, float, float);
extern __m128  _mm_setr_ps(float, float, float, float);
extern __m128  _mm_load_ss(const float *);
extern __m128  _mm_loadu_ps(const float *);
extern __m128  _mm_load_ps(const float *);
extern void    _mm_storeu_ps(float *, __m128);
extern void    _mm_store_ss(float *, __m128);
extern __m128  _mm_unpacklo_ps(__m128, __m128);
extern __m128  _mm_unpackhi_ps(__m128, __m128);
extern __m128  _mm_shuffle_ps(__m128, __m128, int);
extern __m128  _mm_movehdup_ps(__m128);
extern __m128  _mm_moveldup_ps(__m128);
extern __m128  _mm_movehl_ps(__m128, __m128);
extern __m128  _mm_movelh_ps(__m128, __m128);
extern __m128  _mm_hadd_ps(__m128, __m128);
extern __m128d _mm_hadd_pd(__m128d, __m128d);
extern __m128d _mm_hsub_pd(__m128d, __m128d);
extern float   _mm_cvtss_f32(__m128);
extern __m128i _mm_cvttps_epi32(__m128);
extern __m128  _mm_sqrt_ps(__m128);
extern __m128  _mm_rsqrt_ps(__m128);
extern __m128  _mm_rcp_ps(__m128);
extern __m128  _mm_cvtepi32_ps(__m128i);
extern __m128  _mm_cmpunord_ps(__m128, __m128);
extern __m128  _mm_cmpeq_ps(__m128, __m128);
extern __m128  _mm_cmpneq_ps(__m128, __m128);
extern __m128  _mm_cmplt_ps(__m128, __m128);
extern __m128  _mm_cmpgt_ps(__m128, __m128);
extern __m128  _mm_cmple_ps(__m128, __m128);
extern __m128  _mm_cmpge_ps(__m128, __m128);
extern __m128i _mm_castps_si128(__m128);
extern __m128  _mm_castsi128_ps(__m128i);
extern int     _mm_movemask_ps(__m128);
extern __m128  _mm_insert_ps(__m128, __m128, int);
extern int     _mm_extract_ps(__m128, int);
extern __m128  _mm_blendv_ps(__m128, __m128, __m128);
extern __m128  _mm_blend_ps(__m128, __m128, int);
extern __m128  _mm_sqrt_ss(__m128);
extern __m128  _mm_rsqrt_ss(__m128);
extern __m128  _mm_add_ss(__m128, __m128);
extern __m128  _mm_sub_ss(__m128, __m128);
extern __m128  _mm_mul_ss(__m128, __m128);
extern __m128  _mm_div_ss(__m128, __m128);
extern __m128  _mm_range_ps(__m128, __m128, int, int);
extern __m128  _mm_fmadd_ps(__m128, __m128, __m128);
extern __m128  _mm_fnmadd_ps(__m128, __m128, __m128);
extern __m128  _mm_fixupimm_ps(__m128, __m128, __m128i, int);
extern __mmask16 _mm_fpclass_ps_mask(__m128, int);
extern __m128  _mm_maskz_mov_ps(__mmask16, __m128);
extern __m128  _mm_i32gather_ps(const float *, __m128i);
extern __m128  _mm_cvtpd_ps(__m128d);

// ---- integer lanes (__m128i) ----
extern __m128i _mm_add_epi32(__m128i, __m128i);
extern __m128i _mm_sub_epi32(__m128i, __m128i);
extern __m128i _mm_min_epi32(__m128i, __m128i);
extern __m128i _mm_max_epi32(__m128i, __m128i);
extern __m128i _mm_min_epu32(__m128i, __m128i);
extern __m128i _mm_max_epu32(__m128i, __m128i);
extern __m128i _mm_and_si128(__m128i, __m128i);
extern __m128i _mm_or_si128(__m128i, __m128i);
extern __m128i _mm_xor_si128(__m128i, __m128i);
extern __m128i _mm_andnot_si128(__m128i, __m128i);
extern __m128i _mm_set1_epi32(int);
extern __m128i _mm_set1_epi64x(long long);
extern __m128i _mm_set1_epi8(char);
extern __m128i _mm_setzero_si128(void);
extern __m128i _mm_set_epi32(int, int, int, int);
extern __m128i _mm_set_epi64x(long long, long long);
extern __m128i _mm_setr_epi32(int, int, int, int);
extern __m128i _mm_set_epi8(char, char, char, char, char, char, char, char, char, char, char, char, char, char, char, char);
extern __m128i _mm_cmpeq_epi32(__m128i, __m128i);
extern __m128i _mm_cmpeq_epi64(__m128i, __m128i);
extern __m128i _mm_cmpeq_epi8(__m128i, __m128i);
extern __m128i _mm_cmpgt_epi32(__m128i, __m128i);
extern __m128i _mm_cmplt_epi32(__m128i, __m128i);
extern __m128i _mm_slli_epi32(__m128i, int);
extern __m128i _mm_srli_epi32(__m128i, int);
extern __m128i _mm_srai_epi32(__m128i, int);
extern __m128i _mm_mullo_epi32(__m128i, __m128i);
extern __m128i _mm_shuffle_epi32(__m128i, int);
extern __m128i _mm_shuffle_epi8(__m128i, __m128i);
extern __m128i _mm_ternarylogic_epi32(__m128i, __m128i, __m128i, int);
extern __m128i _mm_i32gather_epi32(const int *, __m128i);
extern int     _mm_cvtsi128_si32(__m128i);
extern void    _mm_store_si128(__m128i *, __m128i);
extern void    _mm_storeu_si128(__m128i *, __m128i);
extern void    _mm_stream_si128(__m128i *, __m128i);
extern __m128i _mm_load_si128(const __m128i *);
extern __m128i _mm_loadu_si128(const __m128i *);
extern __m128i _mm_unpacklo_epi16(__m128i, __m128i);
extern __m128i _mm_unpackhi_epi16(__m128i, __m128i);
extern __m128i _mm_undefined_si128(void);
extern int     _mm_movemask_epi8(__m128i);

// ---- double lanes (__m128d) — parse-only (DVec3/DMat44 headers) ----
extern __m128d _mm_undefined_pd(void);
extern __m128d _mm_set_sd(double);
extern __m128d _mm_set_pd(double, double);
extern __m128d _mm_set1_pd(double);
extern __m128d _mm_setzero_pd(void);
extern __m128d _mm_load_sd(const double *);
extern __m128d _mm_loadu_pd(const double *);
extern __m128d _mm_load_pd(const double *);
extern __m128d _mm_add_pd(__m128d, __m128d);
extern __m128d _mm_sub_pd(__m128d, __m128d);
extern __m128d _mm_mul_pd(__m128d, __m128d);
extern __m128d _mm_mul_sd(__m128d, __m128d);
extern __m128d _mm_div_pd(__m128d, __m128d);
extern __m128d _mm_sqrt_pd(__m128d);
extern __m128d _mm_sqrt_sd(__m128d, __m128d);
extern __m128d _mm_unpacklo_pd(__m128d, __m128d);
extern __m128d _mm_unpackhi_pd(__m128d, __m128d);
extern __m128d _mm_shuffle_pd(__m128d, __m128d, int);
extern __m128d _mm_blendv_pd(__m128d, __m128d, __m128d);
extern __m128d _mm_and_pd(__m128d, __m128d);
extern __m128d _mm_or_pd(__m128d, __m128d);
extern __m128d _mm_xor_pd(__m128d, __m128d);
extern __m128d _mm_min_pd(__m128d, __m128d);
extern __m128d _mm_max_pd(__m128d, __m128d);
extern __m128d _mm_cmpeq_pd(__m128d, __m128d);
extern __m128d _mm_cmpge_pd(__m128d, __m128d);
extern __m128d _mm_cmpgt_pd(__m128d, __m128d);
extern __m128d _mm_cmple_pd(__m128d, __m128d);
extern __m128d _mm_cmplt_pd(__m128d, __m128d);
extern __m128d _mm_cmpunord_pd(__m128d, __m128d);
extern int     _mm_movemask_pd(__m128d);
extern void    _mm_storeu_pd(double *, __m128d);
extern void    _mm_store_pd(double *, __m128d);
extern double  _mm_cvtsd_f64(__m128d);
extern __m128d _mm_cvtps_pd(__m128);
extern __m128d _mm_castps_pd(__m128);
extern __m128  _mm_castpd_ps(__m128d);
extern __m128i _mm_castpd_si128(__m128d);
extern __m128d _mm_castsi128_pd(__m128i);

// ---- misc ----
extern unsigned _mm_getcsr(void);
extern void     _mm_setcsr(unsigned);
extern int      _mm_popcnt_u32(unsigned);
extern void     _mm_prefetch(const void *, int);
extern __m128   _mm_cvtph_ps(__m128i);
extern __m128i  _mm_cvtps_ph(__m128, int);

#endif // OURO_SSE_SHIM
