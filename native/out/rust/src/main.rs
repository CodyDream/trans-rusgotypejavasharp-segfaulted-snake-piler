#![allow(non_snake_case, non_camel_case_types, unused_variables,
        dead_code, unused_unsafe, unused_mut, unused_parens)]
use std::arch::x86_64::*;

#[derive(Clone, Copy)]
pub struct FBits { pub f: f32, pub u: u32 }

impl Default for FBits {
    fn default() -> Self { FBits { f: 0.0f32, u: 0u32 } }
}

unsafe fn lane_set_f(v: __m128, idx: usize, x: f32) -> __m128 {
    let mut a = [0f32; 4];
    _mm_storeu_ps(a.as_mut_ptr(), v);
    a[idx] = x;
    _mm_loadu_ps(a.as_ptr())
}

unsafe fn lane_set_u(v: __m128i, idx: usize, x: u32) -> __m128i {
    let mut a = [0u32; 4];
    _mm_storeu_si128(a.as_mut_ptr() as *mut __m128i, v);
    a[idx] = x;
    _mm_loadu_si128(a.as_ptr() as *const __m128i)
}

unsafe fn lane_get_f(v: __m128, idx: usize) -> f32 {
    match idx {
        0 => f32::from_bits(_mm_extract_ps(v, 0) as u32),
        1 => f32::from_bits(_mm_extract_ps(v, 1) as u32),
        2 => f32::from_bits(_mm_extract_ps(v, 2) as u32),
        3 => f32::from_bits(_mm_extract_ps(v, 3) as u32),
        _ => 0.0f32,
    }
}

unsafe fn lane_get_u(v: __m128i, idx: usize) -> u32 {
    match idx {
        0 => _mm_extract_epi32(v, 0) as u32,
        1 => _mm_extract_epi32(v, 1) as u32,
        2 => _mm_extract_epi32(v, 2) as u32,
        3 => _mm_extract_epi32(v, 3) as u32,
        _ => 0u32,
    }
}

#[derive(Clone, Copy, Default)]
pub struct Float3 { pub x: f32, pub y: f32, pub z: f32 }

impl Float3 {
    pub unsafe fn ctor_f32_f32_f32(mut inX: f32, mut inY: f32, mut inZ: f32) -> Float3 {
        let mut __this: Float3 = Float3::default();
        __this
    }

}

#[derive(Clone, Copy, Default)]
pub struct Float4 { pub x: f32, pub y: f32, pub z: f32, pub w: f32 }

impl Float4 {
    pub unsafe fn ctor_f32_f32_f32_f32(mut inX: f32, mut inY: f32, mut inZ: f32, mut inW: f32) -> Float4 {
        let mut __this: Float4 = Float4::default();
        __this
    }

}

#[derive(Clone, Copy)]
pub struct Vec4 { pub mValue: __m128 }
impl Default for Vec4 {
    fn default() -> Self { unsafe { Vec4 { mValue: _mm_setzero_ps() } } }
}

impl Vec4 {
    pub unsafe fn ctor_v128f(mut inRHS: __m128) -> Vec4 {
        let mut __this: Vec4 = Vec4::default();
        __this.mValue = inRHS;
        __this
    }

    pub unsafe fn GetX_c(self) -> f32 {
        return _mm_cvtss_f32(self.mValue);
    }

    pub unsafe fn GetY_c(self) -> f32 {
        return f32::from_bits(_mm_extract_ps(self.mValue, 1) as u32);
    }

    pub unsafe fn GetZ_c(self) -> f32 {
        return f32::from_bits(_mm_extract_ps(self.mValue, 2) as u32);
    }

    pub unsafe fn GetW_c(self) -> f32 {
        return f32::from_bits(_mm_extract_ps(self.mValue, 3) as u32);
    }

    pub unsafe fn SetX_f32(&mut self, mut inX: f32) {
        self.mValue = lane_set_f(self.mValue, (0i32) as usize, inX);
    }

    pub unsafe fn SetY_f32(&mut self, mut inY: f32) {
        self.mValue = lane_set_f(self.mValue, (1i32) as usize, inY);
    }

    pub unsafe fn SetZ_f32(&mut self, mut inZ: f32) {
        self.mValue = lane_set_f(self.mValue, (2i32) as usize, inZ);
    }

    pub unsafe fn SetW_f32(&mut self, mut inW: f32) {
        self.mValue = lane_set_f(self.mValue, (3i32) as usize, inW);
    }

    pub unsafe fn Set_f32_f32_f32_f32(self, mut inX: f32, mut inY: f32, mut inZ: f32, mut inW: f32) {
    }

    pub unsafe fn op_index_u32_c(self, mut inCoordinate: u32) -> f32 {
        ();
        return lane_get_f(self.mValue, (inCoordinate) as usize);
    }

    pub unsafe fn op_index_u32(self, mut inCoordinate: u32) -> f32 {
        ();
        return lane_get_f(self.mValue, (inCoordinate) as usize);
    }

    pub unsafe fn op_ne_Vec4_c(self, mut inV2: Vec4) -> bool {
        return (!self.op_eq_Vec4_c(inV2));
    }

    pub unsafe fn ctor_Vec3(mut inRHS: Vec3) -> Vec4 {
        let mut __this: Vec4 = Vec4::default();
        __this.mValue = inRHS.mValue;
        __this
    }

    pub unsafe fn ctor_Vec3_f32(mut inRHS: Vec3, mut inW: f32) -> Vec4 {
        let mut __this: Vec4 = Vec4::default();
        __this.mValue = _mm_blend_ps(inRHS.mValue, _mm_set1_ps(inW), 8i32);
        __this
    }

    pub unsafe fn ctor_f32_f32_f32_f32(mut inX: f32, mut inY: f32, mut inZ: f32, mut inW: f32) -> Vec4 {
        let mut __this: Vec4 = Vec4::default();
        __this.mValue = _mm_setr_ps(inX, inY, inZ, inW);
        __this
    }

    pub unsafe fn sZero() -> Vec4 {
        return Vec4::ctor_v128f(_mm_setzero_ps());
    }

    pub unsafe fn sReplicate_f32(mut inV: f32) -> Vec4 {
        return Vec4::ctor_v128f(_mm_set1_ps(inV));
    }

    pub unsafe fn sOne() -> Vec4 {
        return Vec4::sReplicate_f32(1.0f32);
    }

    pub unsafe fn sNaN() -> Vec4 {
        return Vec4::sReplicate_f32(f32::NAN);
    }

    pub unsafe fn sLoadFloat4_mut_Float4(mut inV: &mut Float4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_loadu_ps(&mut inV.x));
    }

    pub unsafe fn sLoadFloat4Aligned_mut_Float4(mut inV: &mut Float4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_loadu_ps(&mut inV.x));
    }

    pub unsafe fn sMin_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_min_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sMax_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_max_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sClamp_Vec4_Vec4_Vec4(mut inV: Vec4, mut inMin: Vec4, mut inMax: Vec4) -> Vec4 {
        return Vec4::sMax_Vec4_Vec4(Vec4::sMin_Vec4_Vec4(inV, inMax), inMin);
    }

    pub unsafe fn sEquals_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmpeq_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sLess_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmplt_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sLessOrEqual_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmple_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sGreater_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmpgt_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sGreaterOrEqual_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmpge_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sFusedMultiplyAdd_Vec4_Vec4_Vec4(mut inMul1: Vec4, mut inMul2: Vec4, mut inAdd: Vec4) -> Vec4 {
        return inMul1.op_mul_Vec4_c(inMul2).op_add_Vec4_c(inAdd);
    }

    pub unsafe fn sSelect_Vec4_Vec4_UVec4(mut inNotSet: Vec4, mut inSet: Vec4, mut inControl: UVec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_blendv_ps(inNotSet.mValue, inSet.mValue, _mm_castsi128_ps(inControl.mValue)));
    }

    pub unsafe fn sOr_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_or_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sXor_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_xor_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sAnd_Vec4_Vec4(mut inV1: Vec4, mut inV2: Vec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_and_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sSort4_Vec4_UVec4(mut ioValue: Vec4, mut ioIndex: UVec4) {
        let mut v1: Vec4 = (Vec4::ctor_v128f(_mm_shuffle_ps(ioValue.mValue, ioValue.mValue, 78)));
        let mut i1: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(ioIndex.mValue, 78)));
        let mut c1: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(Vec4::sLess_Vec4_Vec4(ioValue, v1).mValue, 238)));
        let mut v2: Vec4 = (Vec4::ctor_v128f(_mm_shuffle_ps(ioValue.mValue, ioValue.mValue, 177)));
        let mut i2: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(ioIndex.mValue, 177)));
        let mut c2: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(Vec4::sLess_Vec4_Vec4(ioValue, v2).mValue, 245)));
        let mut v3: Vec4 = (Vec4::ctor_v128f(_mm_shuffle_ps(ioValue.mValue, ioValue.mValue, 216)));
        let mut i3: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(ioIndex.mValue, 216)));
        let mut c3: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(Vec4::sLess_Vec4_Vec4(ioValue, v3).mValue, 232)));
    }

    pub unsafe fn sSort4Reverse_Vec4_UVec4(mut ioValue: Vec4, mut ioIndex: UVec4) {
        let mut v1: Vec4 = (Vec4::ctor_v128f(_mm_shuffle_ps(ioValue.mValue, ioValue.mValue, 78)));
        let mut i1: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(ioIndex.mValue, 78)));
        let mut c1: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(Vec4::sGreater_Vec4_Vec4(ioValue, v1).mValue, 238)));
        let mut v2: Vec4 = (Vec4::ctor_v128f(_mm_shuffle_ps(ioValue.mValue, ioValue.mValue, 177)));
        let mut i2: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(ioIndex.mValue, 177)));
        let mut c2: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(Vec4::sGreater_Vec4_Vec4(ioValue, v2).mValue, 245)));
        let mut v3: Vec4 = (Vec4::ctor_v128f(_mm_shuffle_ps(ioValue.mValue, ioValue.mValue, 216)));
        let mut i3: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(ioIndex.mValue, 216)));
        let mut c3: UVec4 = (UVec4::ctor_v128i(_mm_shuffle_epi32(Vec4::sGreater_Vec4_Vec4(ioValue, v3).mValue, 232)));
    }

    pub unsafe fn op_eq_Vec4_c(self, mut inV2: Vec4) -> bool {
        return Vec4::sEquals_Vec4_Vec4(self, inV2).TestAllTrue_c();
    }

    pub unsafe fn IsClose_Vec4_f32_c(self, mut inV2: Vec4, mut inMaxDistSq: f32) -> bool {
        return (inV2.op_sub_Vec4_c(self).LengthSq_c() <= inMaxDistSq);
    }

    pub unsafe fn IsNearZero_f32_c(self, mut inMaxDistSq: f32) -> bool {
        return (self.LengthSq_c() <= inMaxDistSq);
    }

    pub unsafe fn IsNormalized_f32_c(self, mut inTolerance: f32) -> bool {
        return ((self.LengthSq_c() - 1.0f32).abs() <= inTolerance);
    }

    pub unsafe fn IsNaN_c(self) -> bool {
        return (_mm_movemask_ps(_mm_cmpunord_ps(self.mValue, self.mValue)) != 0i32);
    }

    pub unsafe fn op_mul_Vec4_c(self, mut inV2: Vec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_mul_ps(self.mValue, inV2.mValue));
    }

    pub unsafe fn op_mul_f32_c(self, mut inV2: f32) -> Vec4 {
        return Vec4::ctor_v128f(_mm_mul_ps(self.mValue, _mm_set1_ps(inV2)));
    }

    pub unsafe fn op_div_f32_c(self, mut inV2: f32) -> Vec4 {
        return Vec4::ctor_v128f(_mm_div_ps(self.mValue, _mm_set1_ps(inV2)));
    }

    pub unsafe fn op_imul_f32(&mut self, mut inV2: f32) {
        self.mValue = _mm_mul_ps(self.mValue, _mm_set1_ps(inV2));
    }

    pub unsafe fn op_imul_Vec4(&mut self, mut inV2: Vec4) {
        self.mValue = _mm_mul_ps(self.mValue, inV2.mValue);
    }

    pub unsafe fn op_idiv_f32(&mut self, mut inV2: f32) {
        self.mValue = _mm_div_ps(self.mValue, _mm_set1_ps(inV2));
    }

    pub unsafe fn op_add_Vec4_c(self, mut inV2: Vec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_add_ps(self.mValue, inV2.mValue));
    }

    pub unsafe fn op_iadd_Vec4(&mut self, mut inV2: Vec4) {
        self.mValue = _mm_add_ps(self.mValue, inV2.mValue);
    }

    pub unsafe fn op_sub_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_sub_ps(_mm_setzero_ps(), self.mValue));
    }

    pub unsafe fn op_sub_Vec4_c(self, mut inV2: Vec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_sub_ps(self.mValue, inV2.mValue));
    }

    pub unsafe fn op_isub_Vec4(&mut self, mut inV2: Vec4) {
        self.mValue = _mm_sub_ps(self.mValue, inV2.mValue);
    }

    pub unsafe fn op_div_Vec4_c(self, mut inV2: Vec4) -> Vec4 {
        return Vec4::ctor_v128f(_mm_div_ps(self.mValue, inV2.mValue));
    }

    pub unsafe fn SplatX_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 0));
    }

    pub unsafe fn SplatY_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 85));
    }

    pub unsafe fn SplatZ_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 170));
    }

    pub unsafe fn SplatW_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 255));
    }

    pub unsafe fn SplatX3_c(self) -> Vec3 {
        return Vec3::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 0));
    }

    pub unsafe fn SplatY3_c(self) -> Vec3 {
        return Vec3::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 85));
    }

    pub unsafe fn SplatZ3_c(self) -> Vec3 {
        return Vec3::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 170));
    }

    pub unsafe fn SplatW3_c(self) -> Vec3 {
        return Vec3::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 255));
    }

    pub unsafe fn GetLowestComponentIndex_c(self) -> i32 {
        let mut value: Vec4 = (Vec4::sMin_Vec4_Vec4(self, Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 177))));
        return (Vec4::sEquals_Vec4_Vec4(self, value).GetTrues_c() as u32).trailing_zeros() as i32;
    }

    pub unsafe fn GetHighestComponentIndex_c(self) -> i32 {
        let mut value: Vec4 = (Vec4::sMax_Vec4_Vec4(self, Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 177))));
        return (Vec4::sEquals_Vec4_Vec4(self, value).GetTrues_c() as u32).trailing_zeros() as i32;
    }

    pub unsafe fn Abs_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_max_ps(_mm_sub_ps(_mm_setzero_ps(), self.mValue), self.mValue));
    }

    pub unsafe fn Reciprocal_c(self) -> Vec4 {
        return Vec4::sOne().op_div_Vec4_c(Vec4::ctor_v128f(self.mValue));
    }

    pub unsafe fn sDifferenceOfProducts_Vec4_Vec4_Vec4_Vec4(mut inA: Vec4, mut inB: Vec4, mut inC: Vec4, mut inD: Vec4) -> Vec4 {
        return inA.op_mul_Vec4_c(inB).op_sub_Vec4_c(inC.op_mul_Vec4_c(inD));
    }

    pub unsafe fn ReduceSum_c(self) -> f32 {
        let mut shuf: __m128 = (_mm_movehdup_ps(self.mValue));
        let mut sums: __m128 = (_mm_add_ps(self.mValue, shuf));
        shuf = _mm_movehl_ps(sums, sums);
        sums = _mm_add_ps(sums, shuf);
        return _mm_cvtss_f32(sums);
    }

    pub unsafe fn Dot_Vec4_c(self, mut inV2: Vec4) -> f32 {
        return self.op_mul_Vec4_c(inV2).ReduceSum_c();
    }

    pub unsafe fn DotV_Vec4_c(self, mut inV2: Vec4) -> Vec4 {
        return Vec4::sReplicate_f32(self.Dot_Vec4_c(inV2));
    }

    pub unsafe fn LengthSq_c(self) -> f32 {
        return self.Dot_Vec4_c(self);
    }

    pub unsafe fn Length_c(self) -> f32 {
        return self.LengthSq_c().sqrt();
    }

    pub unsafe fn Normalized_c(self) -> Vec4 {
        return self.op_div_f32_c(self.Length_c());
    }

    pub unsafe fn Sqrt_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_sqrt_ps(self.mValue));
    }

    pub unsafe fn GetSign_c(self) -> Vec4 {
        let mut minus_one: __m128 = (_mm_set1_ps((-1.0f32)));
        let mut one: __m128 = (_mm_set1_ps(1.0f32));
        return Vec4::ctor_v128f(_mm_or_ps(_mm_and_ps(self.mValue, minus_one), one));
    }

    pub unsafe fn StoreFloat4_mut_Float4_c(self, mut outV: &mut Float4) {
        _mm_storeu_ps(&mut outV.x as *mut f32, self.mValue);
    }

    pub unsafe fn ToInt_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_cvttps_epi32(self.mValue));
    }

    pub unsafe fn ReinterpretAsInt_c(self) -> UVec4 {
        return (UVec4::ctor_v128i(_mm_castps_si128(self.mValue)) as UVec4);
    }

    pub unsafe fn GetSignBits_c(self) -> i32 {
        return _mm_movemask_ps(self.mValue);
    }

    pub unsafe fn ReduceMin_c(self) -> f32 {
        let mut v: Vec4 = (Vec4::sMin_Vec4_Vec4(Vec4::ctor_v128f(self.mValue), Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 49))));
        return v.GetX_c();
    }

    pub unsafe fn ReduceMax_c(self) -> f32 {
        let mut v: Vec4 = (Vec4::sMax_Vec4_Vec4(Vec4::ctor_v128f(self.mValue), Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 49))));
        return v.GetX_c();
    }

    pub unsafe fn CompressUnitVector_c(self) -> u32 {
        let mut cOneOverSqrt2: f32 = (0.70710678f32);
        let mut cNumBits: u32 = (9u32);
        let mut cMask: u32 = (((1i32 << (cNumBits as i32)) - 1i32)) as u32;
        let mut cMaxValue: u32 = ((cMask - 1u32));
        let mut cScale: f32 = (((cMaxValue as f32) / (2.0f32 * cOneOverSqrt2)));
        let mut v: Vec4 = self;
        let mut max_element: u32 = (v.Abs_c().GetHighestComponentIndex_c()) as u32;
        let mut value: u32 = (0u32);
        if (v.op_index_u32(max_element) < 0.0f32) {
            value = 0x80000000u32;
        }
        value = (value | (max_element << (29i32 as u32)));
        let mut compressed: UVec4 = (Vec4::sClamp_Vec4_Vec4_Vec4(v.op_add_Vec4_c(Vec4::sReplicate_f32(cOneOverSqrt2)).op_mul_f32_c(cScale).op_add_Vec4_c(Vec4::sReplicate_f32(0.5f32)), Vec4::sZero(), Vec4::sReplicate_f32((cMaxValue as f32))).ToInt_c());
        value = (value | compressed.GetX_c());
        value = (value | (compressed.GetY_c() << cNumBits));
        value = (value | (compressed.GetZ_c() * (2u32 * cNumBits)));
        return value;
    }

    pub unsafe fn sDecompressUnitVector_u32(mut inValue: u32) -> Vec4 {
        let mut cOneOverSqrt2: f32 = (0.70710678f32);
        let mut cNumBits: u32 = (9u32);
        let mut cMask: u32 = (((1u32 << cNumBits) - 1u32));
        let mut cMaxValue: u32 = ((cMask - 1u32));
        let mut cHalfMaxValue: i32 = (((cMaxValue >> (1i32 as u32)) as i32)) as i32;
        let mut cScale: f32 = (((2.0f32 * cOneOverSqrt2) * (cMaxValue as f32)));
        let mut v: Vec4 = (Vec4::ctor_f32_f32_f32_f32((((((inValue & cMask) as i32) as i32) - cHalfMaxValue) as f32), ((((((inValue >> cNumBits) & cMask) as i32) as i32) - cHalfMaxValue) as f32), ((((((inValue >> (2u32 * cNumBits)) as i32) as u32) & cMask) as f32) - (cHalfMaxValue as f32)), 0.0f32).op_mul_f32_c(cScale));
        ();
        v.SetW_f32((if ((1.0f32 - v.LengthSq_c()) > 0.0f32) { 0.0f32 } else { (1.0f32 - v.LengthSq_c()) }).sqrt());
        if ((inValue & 0x80000000u32) != 0u32) {
        }
        return v;
    }

}

#[derive(Clone, Copy)]
pub struct Vec3 { pub mValue: __m128 }
impl Default for Vec3 {
    fn default() -> Self { unsafe { Vec3 { mValue: _mm_setzero_ps() } } }
}

impl Vec3 {
    pub unsafe fn ctor_v128f(mut inRHS: __m128) -> Vec3 {
        let mut __this: Vec3 = Vec3::default();
        __this.mValue = inRHS;
        __this.CheckW_c();
        __this
    }

    pub unsafe fn sAxisX() -> Vec3 {
        return Vec3::ctor_f32_f32_f32(1.0f32, 0.0f32, 0.0f32);
    }

    pub unsafe fn sAxisY() -> Vec3 {
        return Vec3::ctor_f32_f32_f32(0.0f32, 1.0f32, 0.0f32);
    }

    pub unsafe fn sAxisZ() -> Vec3 {
        return Vec3::ctor_f32_f32_f32(0.0f32, 0.0f32, 1.0f32);
    }

    pub unsafe fn GetX_c(self) -> f32 {
        return _mm_cvtss_f32(self.mValue);
    }

    pub unsafe fn GetY_c(self) -> f32 {
        return f32::from_bits(_mm_extract_ps(self.mValue, 1) as u32);
    }

    pub unsafe fn GetZ_c(self) -> f32 {
        return f32::from_bits(_mm_extract_ps(self.mValue, 2) as u32);
    }

    pub unsafe fn SetX_f32(&mut self, mut inX: f32) {
        self.mValue = lane_set_f(self.mValue, (0i32) as usize, inX);
    }

    pub unsafe fn SetY_f32(&mut self, mut inY: f32) {
        self.mValue = lane_set_f(self.mValue, (1i32) as usize, inY);
    }

    pub unsafe fn SetZ_f32(&mut self, mut inZ: f32) {
        self.mValue = lane_set_f(self.mValue, (2i32) as usize, inZ);
    }

    pub unsafe fn Set_f32_f32_f32(self, mut inX: f32, mut inY: f32, mut inZ: f32) {
    }

    pub unsafe fn op_index_u32_c(self, mut inCoordinate: u32) -> f32 {
        ();
        return lane_get_f(self.mValue, (inCoordinate) as usize);
    }

    pub unsafe fn SetComponent_u32_f32(&mut self, mut inCoordinate: u32, mut inValue: f32) {
        ();
        self.mValue = lane_set_f(self.mValue, (inCoordinate) as usize, inValue);
        self.mValue = Vec3::sFixW_v128f(self.mValue);
    }

    pub unsafe fn op_ne_Vec3_c(self, mut inV2: Vec3) -> bool {
        return (!self.op_eq_Vec3_c(inV2));
    }

    pub unsafe fn CheckW_c(self) {
    }

    pub unsafe fn sFixW_v128f(mut inValue: __m128) -> __m128 {
        return inValue;
    }

    pub unsafe fn ctor_Vec4(mut inRHS: Vec4) -> Vec3 {
        let mut __this: Vec3 = Vec3::default();
        __this.mValue = Vec3::sFixW_v128f(inRHS.mValue);
        __this
    }

    pub unsafe fn ctor_Float3(mut inV: Float3) -> Vec3 {
        let mut __this: Vec3 = Vec3::default();
        let mut x: __m128 = (_mm_load_ss(&mut inV.x));
        let mut y: __m128 = (_mm_load_ss(&mut inV.y));
        let mut z: __m128 = (_mm_load_ss(&mut inV.z));
        let mut xy: __m128 = (_mm_unpacklo_ps(x, y));
        __this.mValue = _mm_shuffle_ps(xy, z, 4);
        __this
    }

    pub unsafe fn ctor_f32_f32_f32(mut inX: f32, mut inY: f32, mut inZ: f32) -> Vec3 {
        let mut __this: Vec3 = Vec3::default();
        __this.mValue = _mm_setr_ps(inX, inY, inZ, inZ);
        __this
    }

    pub unsafe fn sZero() -> Vec3 {
        return Vec3::ctor_v128f(_mm_setzero_ps());
    }

    pub unsafe fn sReplicate_f32(mut inV: f32) -> Vec3 {
        return Vec3::ctor_v128f(_mm_set1_ps(inV));
    }

    pub unsafe fn sOne() -> Vec3 {
        return Vec3::sReplicate_f32(1.0f32);
    }

    pub unsafe fn sNaN() -> Vec3 {
        return Vec3::sReplicate_f32(f32::NAN);
    }

    pub unsafe fn sLoadFloat3Unsafe_Float3(mut inV: Float3) -> Vec3 {
        let mut v: __m128 = (_mm_loadu_ps(&mut inV.x));
        return Vec3::ctor_v128f(Vec3::sFixW_v128f(v));
    }

    pub unsafe fn sMin_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> Vec3 {
        return Vec3::ctor_v128f(_mm_min_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sMax_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> Vec3 {
        return Vec3::ctor_v128f(_mm_max_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sClamp_Vec3_Vec3_Vec3(mut inV: Vec3, mut inMin: Vec3, mut inMax: Vec3) -> Vec3 {
        return Vec3::sMax_Vec3_Vec3(Vec3::sMin_Vec3_Vec3(inV, inMax), inMin);
    }

    pub unsafe fn sEquals_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmpeq_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sLess_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmplt_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sLessOrEqual_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmple_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sGreater_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmpgt_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sGreaterOrEqual_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_cmpge_ps(inV1.mValue, inV2.mValue)));
    }

    pub unsafe fn sFusedMultiplyAdd_Vec3_Vec3_Vec3(mut inMul1: Vec3, mut inMul2: Vec3, mut inAdd: Vec3) -> Vec3 {
        return inMul1.op_mul_Vec3_c(inMul2).op_add_Vec3_c(inAdd);
    }

    pub unsafe fn sSelect_Vec3_Vec3_UVec4(mut inNotSet: Vec3, mut inSet: Vec3, mut inControl: UVec4) -> Vec3 {
        let mut v: __m128 = (_mm_blendv_ps(inNotSet.mValue, inSet.mValue, _mm_castsi128_ps(inControl.mValue)));
        return Vec3::ctor_v128f(Vec3::sFixW_v128f(v));
    }

    pub unsafe fn sOr_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> Vec3 {
        return Vec3::ctor_v128f(_mm_or_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sXor_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> Vec3 {
        return Vec3::ctor_v128f(_mm_xor_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sAnd_Vec3_Vec3(mut inV1: Vec3, mut inV2: Vec3) -> Vec3 {
        return Vec3::ctor_v128f(_mm_and_ps(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn op_eq_Vec3_c(self, mut inV2: Vec3) -> bool {
        return Vec3::sEquals_Vec3_Vec3(self, inV2).TestAllXYZTrue_c();
    }

    pub unsafe fn IsClose_Vec3_f32_c(self, mut inV2: Vec3, mut inMaxDistSq: f32) -> bool {
        return (inV2.op_sub_Vec3_c(self).LengthSq_c() <= inMaxDistSq);
    }

    pub unsafe fn IsNearZero_f32_c(self, mut inMaxDistSq: f32) -> bool {
        return (self.LengthSq_c() <= inMaxDistSq);
    }

    pub unsafe fn op_mul_Vec3_c(self, mut inV2: Vec3) -> Vec3 {
        return Vec3::ctor_v128f(_mm_mul_ps(self.mValue, inV2.mValue));
    }

    pub unsafe fn op_mul_f32_c(self, mut inV2: f32) -> Vec3 {
        return Vec3::ctor_v128f(_mm_mul_ps(self.mValue, _mm_set1_ps(inV2)));
    }

    pub unsafe fn op_div_f32_c(self, mut inV2: f32) -> Vec3 {
        return Vec3::ctor_v128f(_mm_div_ps(self.mValue, _mm_set1_ps(inV2)));
    }

    pub unsafe fn op_imul_f32(&mut self, mut inV2: f32) {
        self.mValue = _mm_mul_ps(self.mValue, _mm_set1_ps(inV2));
    }

    pub unsafe fn op_imul_Vec3(&mut self, mut inV2: Vec3) {
        self.mValue = _mm_mul_ps(self.mValue, inV2.mValue);
    }

    pub unsafe fn op_idiv_f32(&mut self, mut inV2: f32) {
        self.mValue = _mm_div_ps(self.mValue, _mm_set1_ps(inV2));
    }

    pub unsafe fn op_add_Vec3_c(self, mut inV2: Vec3) -> Vec3 {
        return Vec3::ctor_v128f(_mm_add_ps(self.mValue, inV2.mValue));
    }

    pub unsafe fn op_iadd_Vec3(&mut self, mut inV2: Vec3) {
        self.mValue = _mm_add_ps(self.mValue, inV2.mValue);
    }

    pub unsafe fn op_sub_c(self) -> Vec3 {
        return Vec3::ctor_v128f(_mm_sub_ps(_mm_setzero_ps(), self.mValue));
    }

    pub unsafe fn op_sub_Vec3_c(self, mut inV2: Vec3) -> Vec3 {
        return Vec3::ctor_v128f(_mm_sub_ps(self.mValue, inV2.mValue));
    }

    pub unsafe fn op_isub_Vec3(&mut self, mut inV2: Vec3) {
        self.mValue = _mm_sub_ps(self.mValue, inV2.mValue);
    }

    pub unsafe fn op_div_Vec3_c(self, mut inV2: Vec3) -> Vec3 {
        inV2.CheckW_c();
        return Vec3::ctor_v128f(_mm_div_ps(self.mValue, inV2.mValue));
    }

    pub unsafe fn SplatX_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 0));
    }

    pub unsafe fn SplatY_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 85));
    }

    pub unsafe fn SplatZ_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_shuffle_ps(self.mValue, self.mValue, 170));
    }

    pub unsafe fn GetLowestComponentIndex_c(self) -> i32 {
        return (if (self.GetX_c() < self.GetY_c()) { (if (self.GetZ_c() < self.GetX_c()) { 2i32 } else { 0i32 }) } else { (if (self.GetZ_c() < self.GetY_c()) { 2i32 } else { 1i32 }) });
    }

    pub unsafe fn GetHighestComponentIndex_c(self) -> i32 {
        return (if (self.GetX_c() > self.GetY_c()) { (if (self.GetZ_c() > self.GetX_c()) { 2i32 } else { 0i32 }) } else { (if (self.GetZ_c() > self.GetY_c()) { 2i32 } else { 1i32 }) });
    }

    pub unsafe fn Abs_c(self) -> Vec3 {
        return Vec3::ctor_v128f(_mm_max_ps(_mm_sub_ps(_mm_setzero_ps(), self.mValue), self.mValue));
    }

    pub unsafe fn Reciprocal_c(self) -> Vec3 {
        return Vec3::sOne().op_div_Vec3_c(Vec3::ctor_v128f(self.mValue));
    }

    pub unsafe fn sDifferenceOfProducts_Vec3_Vec3_Vec3_Vec3(mut inA: Vec3, mut inB: Vec3, mut inC: Vec3, mut inD: Vec3) -> Vec3 {
        return inA.op_mul_Vec3_c(inB).op_sub_Vec3_c(inC.op_mul_Vec3_c(inD));
    }

    pub unsafe fn Cross_Vec3_c(self, mut inV2: Vec3) -> Vec3 {
        let mut t1: __m128 = (_mm_shuffle_ps(inV2.mValue, inV2.mValue, 9));
        t1 = _mm_mul_ps(t1, self.mValue);
        let mut t2: __m128 = (_mm_shuffle_ps(self.mValue, self.mValue, 9));
        t2 = _mm_mul_ps(t2, inV2.mValue);
        let mut t3: __m128 = (_mm_sub_ps(t1, t2));
        return Vec3::ctor_v128f(_mm_shuffle_ps(t3, t3, 9));
    }

    pub unsafe fn ReduceSum_c(self) -> f32 {
        let mut shuf: __m128 = (_mm_movehdup_ps(self.mValue));
        let mut sums: __m128 = (_mm_add_ps(self.mValue, shuf));
        shuf = _mm_movehl_ps(self.mValue, self.mValue);
        sums = _mm_add_ps(sums, shuf);
        return _mm_cvtss_f32(sums);
    }

    pub unsafe fn Dot_Vec3_c(self, mut inV2: Vec3) -> f32 {
        return self.op_mul_Vec3_c(inV2).ReduceSum_c();
    }

    pub unsafe fn DotV_Vec3_c(self, mut inV2: Vec3) -> Vec3 {
        return Vec3::sReplicate_f32(self.Dot_Vec3_c(inV2));
    }

    pub unsafe fn DotV4_Vec3_c(self, mut inV2: Vec3) -> Vec4 {
        return Vec4::sReplicate_f32(self.Dot_Vec3_c(inV2));
    }

    pub unsafe fn LengthSq_c(self) -> f32 {
        return self.Dot_Vec3_c(self);
    }

    pub unsafe fn Length_c(self) -> f32 {
        return self.LengthSq_c().sqrt();
    }

    pub unsafe fn Sqrt_c(self) -> Vec3 {
        return Vec3::ctor_v128f(_mm_sqrt_ps(self.mValue));
    }

    pub unsafe fn Normalized_c(self) -> Vec3 {
        return self.op_div_f32_c(self.Length_c());
    }

    pub unsafe fn NormalizedOr_Vec3_c(self, mut inZeroValue: Vec3) -> Vec3 {
        let mut mul: __m128 = (_mm_mul_ps(self.mValue, self.mValue));
        let mut shuf: __m128 = (_mm_movehdup_ps(mul));
        let mut sums: __m128 = (_mm_add_ps(mul, shuf));
        shuf = _mm_movehl_ps(mul, mul);
        sums = _mm_add_ps(sums, shuf);
        let mut len_sq: __m128 = (_mm_shuffle_ps(sums, sums, 0));
        let mut is_zero: __m128 = (_mm_cmple_ps(len_sq, _mm_set1_ps(1.1754943508222875e-38f32)));
        return Vec3::ctor_v128f(_mm_blendv_ps(_mm_div_ps(self.mValue, _mm_sqrt_ps(len_sq)), inZeroValue.mValue, is_zero));
    }

    pub unsafe fn IsNormalized_f32_c(self, mut inTolerance: f32) -> bool {
        return ((self.LengthSq_c() - 1.0f32).abs() <= inTolerance);
    }

    pub unsafe fn IsNaN_c(self) -> bool {
        return ((_mm_movemask_ps(_mm_cmpunord_ps(self.mValue, self.mValue)) & 0x7i32) != 0i32);
    }

    pub unsafe fn ToInt_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_cvttps_epi32(self.mValue));
    }

    pub unsafe fn ReinterpretAsInt_c(self) -> UVec4 {
        return (UVec4::ctor_v128i(_mm_castps_si128(self.mValue)) as UVec4);
    }

    pub unsafe fn GetSign_c(self) -> Vec3 {
        let mut minus_one: __m128 = (_mm_set1_ps((-1.0f32)));
        let mut one: __m128 = (_mm_set1_ps(1.0f32));
        return Vec3::ctor_v128f(_mm_or_ps(_mm_and_ps(self.mValue, minus_one), one));
    }

    pub unsafe fn CompressUnitVector_c(self) -> u32 {
        let mut cOneOverSqrt2: f32 = (0.70710678f32);
        let mut cNumBits: u32 = (14u32);
        let mut cMask: u32 = (((1i32 << (cNumBits as i32)) - 1i32)) as u32;
        let mut cMaxValue: u32 = ((cMask - 1u32));
        let mut cScale: f32 = (((cMaxValue as f32) / (2.0f32 * cOneOverSqrt2)));
        let mut v: Vec3 = self;
        let mut max_element: u32 = (v.Abs_c().GetHighestComponentIndex_c()) as u32;
        let mut value: u32 = (0u32);
        if (v.op_index_u32_c(max_element) < 0.0f32) {
            value = 0x80000000u32;
        }
        value = (value | (max_element << (29i32 as u32)));
        let mut compressed: UVec4 = (Vec3::sClamp_Vec3_Vec3_Vec3(v.op_add_Vec3_c(Vec3::sReplicate_f32(cOneOverSqrt2)).op_mul_f32_c(cScale).op_add_Vec3_c(Vec3::sReplicate_f32(0.5f32)), Vec3::sZero(), Vec3::sReplicate_f32((cMaxValue as f32))).ToInt_c());
        value = (value | compressed.GetX_c());
        value = (value | (compressed.GetY_c() << cNumBits));
        return value;
    }

    pub unsafe fn sDecompressUnitVector_u32(mut inValue: u32) -> Vec3 {
        let mut cOneOverSqrt2: f32 = (0.70710678f32);
        let mut cNumBits: u32 = (14u32);
        let mut cMask: u32 = (((1u32 << cNumBits) - 1u32));
        let mut cMaxValue: u32 = ((cMask - 1u32));
        let mut cHalfMaxValue: i32 = (((cMaxValue >> (1i32 as u32)) as i32)) as i32;
        let mut cScale: f32 = (((2.0f32 * cOneOverSqrt2) * (cMaxValue as f32)));
        let mut v: Vec3 = (Vec3::ctor_f32_f32_f32((((((inValue & cMask) as i32) as i32) - cHalfMaxValue) as f32), ((((((inValue >> cNumBits) & cMask) as i32) as i32) - cHalfMaxValue) as f32), 0.0f32).op_mul_f32_c(cScale));
        ();
        v.SetZ_f32((if ((1.0f32 - v.LengthSq_c()) > 0.0f32) { 0.0f32 } else { (1.0f32 - v.LengthSq_c()) }).sqrt());
        if ((inValue & 0x80000000u32) != 0u32) {
        }
        return v;
    }

}

#[derive(Clone, Copy)]
pub struct UVec4 { pub mValue: __m128i }
impl Default for UVec4 {
    fn default() -> Self { unsafe { UVec4 { mValue: _mm_setzero_si128() } } }
}

impl UVec4 {
    pub unsafe fn ctor_v128i(mut inRHS: __m128i) -> UVec4 {
        let mut __this: UVec4 = UVec4::default();
        __this.mValue = inRHS;
        __this
    }

    pub unsafe fn op_ne_UVec4_c(self, mut inV2: UVec4) -> bool {
        return (!self.op_eq_UVec4_c(inV2));
    }

    pub unsafe fn GetX_c(self) -> u32 {
        return (_mm_cvtsi128_si32(self.mValue) as u32);
    }

    pub unsafe fn GetY_c(self) -> u32 {
        return _mm_extract_epi32(self.mValue, 1) as u32;
    }

    pub unsafe fn GetZ_c(self) -> u32 {
        return _mm_extract_epi32(self.mValue, 2) as u32;
    }

    pub unsafe fn GetW_c(self) -> u32 {
        return _mm_extract_epi32(self.mValue, 3) as u32;
    }

    pub unsafe fn SetX_u32(&mut self, mut inX: u32) {
        self.mValue = lane_set_u(self.mValue, (0i32) as usize, inX);
    }

    pub unsafe fn SetY_u32(&mut self, mut inY: u32) {
        self.mValue = lane_set_u(self.mValue, (1i32) as usize, inY);
    }

    pub unsafe fn SetZ_u32(&mut self, mut inZ: u32) {
        self.mValue = lane_set_u(self.mValue, (2i32) as usize, inZ);
    }

    pub unsafe fn SetW_u32(&mut self, mut inW: u32) {
        self.mValue = lane_set_u(self.mValue, (3i32) as usize, inW);
    }

    pub unsafe fn op_index_u32_c(self, mut inCoordinate: u32) -> u32 {
        ();
        return lane_get_u(self.mValue, (inCoordinate) as usize);
    }

    pub unsafe fn op_index_u32(self, mut inCoordinate: u32) -> u32 {
        ();
        return lane_get_u(self.mValue, (inCoordinate) as usize);
    }

    pub unsafe fn ctor_u32_u32_u32_u32(mut inX: u32, mut inY: u32, mut inZ: u32, mut inW: u32) -> UVec4 {
        let mut __this: UVec4 = UVec4::default();
        __this.mValue = _mm_setr_epi32((inX as i32) as i32, (inY as i32) as i32, (inZ as i32) as i32, (inW as i32) as i32);
        __this
    }

    pub unsafe fn op_eq_UVec4_c(self, mut inV2: UVec4) -> bool {
        return UVec4::sEquals_UVec4_UVec4(self, inV2).TestAllTrue_c();
    }

    pub unsafe fn sZero() -> UVec4 {
        return UVec4::ctor_v128i(_mm_setzero_si128());
    }

    pub unsafe fn sReplicate_u32(mut inV: u32) -> UVec4 {
        return UVec4::ctor_v128i(_mm_set1_epi32((inV as i32) as i32));
    }

    pub unsafe fn sMin_UVec4_UVec4(mut inV1: UVec4, mut inV2: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_min_epu32(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sMax_UVec4_UVec4(mut inV1: UVec4, mut inV2: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_max_epu32(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sEquals_UVec4_UVec4(mut inV1: UVec4, mut inV2: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_cmpeq_epi32(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sSelect_UVec4_UVec4_UVec4(mut inNotSet: UVec4, mut inSet: UVec4, mut inControl: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_castps_si128(_mm_blendv_ps(_mm_castsi128_ps(inNotSet.mValue), _mm_castsi128_ps(inSet.mValue), _mm_castsi128_ps(inControl.mValue))));
    }

    pub unsafe fn sOr_UVec4_UVec4(mut inV1: UVec4, mut inV2: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_or_si128(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sXor_UVec4_UVec4(mut inV1: UVec4, mut inV2: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_xor_si128(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sAnd_UVec4_UVec4(mut inV1: UVec4, mut inV2: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_and_si128(inV1.mValue, inV2.mValue));
    }

    pub unsafe fn sNot_UVec4(mut inV1: UVec4) -> UVec4 {
        return UVec4::sXor_UVec4_UVec4(inV1, UVec4::sReplicate_u32(0xffffffffu32));
    }

    pub unsafe fn sSort4True_UVec4_UVec4(mut inValue: UVec4, mut inIndex: UVec4) -> UVec4 {
        let mut v: UVec4 = (UVec4::sSelect_UVec4_UVec4_UVec4(UVec4::ctor_v128i(_mm_shuffle_epi32(inIndex.mValue, 244)), inIndex, inValue.SplatZ_c()));
        return v;
    }

    pub unsafe fn op_mul_UVec4_c(self, mut inV2: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_mullo_epi32(self.mValue, inV2.mValue));
    }

    pub unsafe fn op_add_UVec4_c(self, mut inV2: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_add_epi32(self.mValue, inV2.mValue));
    }

    pub unsafe fn op_iadd_UVec4(&mut self, mut inV2: UVec4) {
        self.mValue = _mm_add_epi32(self.mValue, inV2.mValue);
    }

    pub unsafe fn op_sub_UVec4_c(self, mut inV2: UVec4) -> UVec4 {
        return UVec4::ctor_v128i(_mm_sub_epi32(self.mValue, inV2.mValue));
    }

    pub unsafe fn op_isub_UVec4(&mut self, mut inV2: UVec4) {
        self.mValue = _mm_sub_epi32(self.mValue, inV2.mValue);
    }

    pub unsafe fn SplatX_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_shuffle_epi32(self.mValue, 0));
    }

    pub unsafe fn SplatY_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_shuffle_epi32(self.mValue, 85));
    }

    pub unsafe fn SplatZ_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_shuffle_epi32(self.mValue, 170));
    }

    pub unsafe fn SplatW_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_shuffle_epi32(self.mValue, 255));
    }

    pub unsafe fn ToFloat_c(self) -> Vec4 {
        return Vec4::ctor_v128f(_mm_cvtepi32_ps(self.mValue));
    }

    pub unsafe fn ReinterpretAsFloat_c(self) -> Vec4 {
        return (Vec4::ctor_v128f(_mm_castsi128_ps(self.mValue)) as Vec4);
    }

    pub unsafe fn StoreInt4_mut_u32_c(self, mut outV: &mut u32) {
    }

    pub unsafe fn StoreInt4Aligned_mut_u32_c(self, mut outV: &mut u32) {
    }

    pub unsafe fn CountTrues_c(self) -> i32 {
        return (_mm_movemask_ps(_mm_castsi128_ps(self.mValue)) as u32).count_ones() as i32;
    }

    pub unsafe fn GetTrues_c(self) -> i32 {
        return _mm_movemask_ps(_mm_castsi128_ps(self.mValue));
    }

    pub unsafe fn TestAnyTrue_c(self) -> bool {
        return (self.GetTrues_c() != 0i32);
    }

    pub unsafe fn TestAnyXYZTrue_c(self) -> bool {
        return ((self.GetTrues_c() & 0b111i32) != 0i32);
    }

    pub unsafe fn TestAllTrue_c(self) -> bool {
        return (self.GetTrues_c() == 0b1111i32);
    }

    pub unsafe fn TestAllXYZTrue_c(self) -> bool {
        return ((self.GetTrues_c() & 0b111i32) == 0b111i32);
    }

    pub unsafe fn Expand4Uint16Lo_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_unpacklo_epi16(self.mValue, _mm_castps_si128(_mm_setzero_ps())));
    }

    pub unsafe fn Expand4Uint16Hi_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_unpackhi_epi16(self.mValue, _mm_castps_si128(_mm_setzero_ps())));
    }

    pub unsafe fn Expand4Byte0_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_shuffle_epi8(self.mValue, _mm_setr_epi32((0xffffff00i32 as i32), (0xffffff01i32 as i32), (0xffffff02i32 as i32), (0xffffff03i32 as i32))));
    }

    pub unsafe fn Expand4Byte4_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_shuffle_epi8(self.mValue, _mm_setr_epi32((0xffffff04i32 as i32), (0xffffff05i32 as i32), (0xffffff06i32 as i32), (0xffffff07i32 as i32))));
    }

    pub unsafe fn Expand4Byte8_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_shuffle_epi8(self.mValue, _mm_setr_epi32((0xffffff08i32 as i32), (0xffffff09i32 as i32), (0xffffff0ai32 as i32), (0xffffff0bi32 as i32))));
    }

    pub unsafe fn Expand4Byte12_c(self) -> UVec4 {
        return UVec4::ctor_v128i(_mm_shuffle_epi8(self.mValue, _mm_setr_epi32((0xffffff0ci32 as i32), (0xffffff0di32 as i32), (0xffffff0ei32 as i32), (0xffffff0fi32 as i32))));
    }

}

pub unsafe fn BitsOf(mut inF: f32) -> u32 {
    let mut b: FBits = FBits::default();
    b.f = inF;
    return b.u;
}

pub unsafe fn P4(mut inName: &'static str, mut inV: Vec4) {
    print!("{}", inName);
    print!("{}", " %08x %08x %08x %08x");
    println!();
}

pub unsafe fn P3(mut inName: &'static str, mut inV: Vec3) {
    print!("{}", inName);
    print!("{}", " %08x %08x %08x");
    println!();
}

pub unsafe fn PU(mut inName: &'static str, mut inV: UVec4) {
    print!("{}", inName);
    print!("{}", " %08x %08x %08x %08x");
    println!();
}

pub unsafe fn PF(mut inName: &'static str, mut inF: f32) {
    print!("{}", inName);
    print!("{}", " %08x");
    println!();
}

pub unsafe fn PB(mut inName: &'static str, mut inB: bool) {
    print!("{}", inName);
    print!("{}", " ");
    print!("{}", (if inB { 1u32 } else { 0u32 }));
    println!();
}

pub unsafe fn Battery() {
    let mut a: Vec4 = (Vec4::ctor_f32_f32_f32_f32(1.5f32, (-2.25f32), 0.75f32, 4.0f32));
    let mut b: Vec4 = (Vec4::ctor_f32_f32_f32_f32((-0.5f32), 3.5f32, 2.0f32, (-1.0f32)));
    let mut c: Vec4 = (Vec4::ctor_f32_f32_f32_f32(0.25f32, 0.125f32, (-8.0f32), 16.0f32));
    let mut p: Vec3 = (Vec3::ctor_f32_f32_f32(1.5f32, (-2.0f32), 0.25f32));
    let mut q: Vec3 = (Vec3::ctor_f32_f32_f32((-3.0f32), 0.5f32, 4.0f32));
    let mut m: UVec4 = (UVec4::ctor_u32_u32_u32_u32(0xffffffffu32, 0x00000000u32, 0x80000000u32, 0x00000001u32));
    let mut n: UVec4 = (UVec4::ctor_u32_u32_u32_u32(0x00000001u32, 0xffffffffu32, 0x80000000u32, 0x00000000u32));
    P4("v4_szero", Vec4::sZero());
    P4("v4_sone", Vec4::sOne());
    P4("v4_snan", Vec4::sNaN());
    P4("v4_sreplicate", Vec4::sReplicate_f32(2.5f32));
    P4("v4_ctor", a);
    let mut d: Vec4 = a;
    P4("v4_copyctor", d);
    let mut d: Vec4 = (Vec4::ctor_Vec3_f32(p, 7.75f32));
    P4("v4_ctor_v3f", d);
    let mut d: Vec4 = Vec4::default();
    d = a;
    P4("v4_defaultassign", d);
    PF("v4_getx", a.GetX_c());
    PF("v4_gety", a.GetY_c());
    PF("v4_getz", a.GetZ_c());
    PF("v4_getw", a.GetW_c());
    let mut d: Vec4 = a;
    d.SetX_f32(9.5f32);
    d.SetY_f32((-0.125f32));
    P4("v4_setxy", d);
    let mut d: Vec4 = a;
    d.Set_f32_f32_f32_f32((-1.0f32), 2.0f32, (-4.0f32), 8.0f32);
    P4("v4_set", d);
    let mut d: Vec4 = a;
    d.SetZ_f32(0.5f32);
    PF("v4_index_get", d.op_index_u32(2u32));
    let mut d: Vec4 = a;
    d.mValue = lane_set_f(d.mValue, (1i32) as usize, 6.25f32);
    P4("v4_index_set", d);
    P4("v4_add", a.op_add_Vec4_c(b));
    P4("v4_sub", a.op_sub_Vec4_c(b));
    P4("v4_neg", a.op_sub_c());
    P4("v4_mulvec", a.op_mul_Vec4_c(b));
    P4("v4_mulfloat", a.op_mul_f32_c(2.0f32));
    P4("v4_mulfloat_friend", a.op_mul_f32_c(2.0f32));
    P4("v4_divfloat", a.op_div_f32_c(4.0f32));
    P4("v4_divvec", a.op_div_Vec4_c(b));
    P4("v4_recip", a.Reciprocal_c());
    let mut d: Vec4 = a;
    d.op_iadd_Vec4(b);
    P4("v4_iadd", d);
    let mut d: Vec4 = a;
    d.op_isub_Vec4(b);
    P4("v4_isub", d);
    let mut d: Vec4 = a;
    d.op_imul_f32(3.0f32);
    P4("v4_imulf", d);
    let mut d: Vec4 = a;
    d.op_imul_Vec4(b);
    P4("v4_imulv", d);
    let mut d: Vec4 = a;
    d.op_idiv_f32(2.0f32);
    P4("v4_idivf", d);
    P4("v4_smin", Vec4::sMin_Vec4_Vec4(a, b));
    P4("v4_smax", Vec4::sMax_Vec4_Vec4(a, b));
    P4("v4_sclamp", Vec4::sClamp_Vec4_Vec4_Vec4(c, a, b));
    P4("v4_abs", a.Abs_c());
    P4("v4_sqrt", c.Sqrt_c());
    PF("v4_length", a.Length_c());
    PF("v4_lengthsq", a.LengthSq_c());
    PF("v4_dot", a.Dot_Vec4_c(b));
    P4("v4_dotv", a.DotV_Vec4_c(b));
    P4("v4_normalized", a.Normalized_c());
    PF("v4_reducesum", a.ReduceSum_c());
    PF("v4_reducemin", a.ReduceMin_c());
    PF("v4_reducemax", a.ReduceMax_c());
    P4("v4_sfma", Vec4::sFusedMultiplyAdd_Vec4_Vec4_Vec4(a, b, c));
    P4("v4_sdop", Vec4::sDifferenceOfProducts_Vec4_Vec4_Vec4_Vec4(a, b, c, a));
    P4("v4_getsign", a.GetSign_c());
    PB("v4_eq_true", a.op_eq_Vec4_c(a));
    PB("v4_eq_false", a.op_eq_Vec4_c(b));
    PB("v4_ne", a.op_ne_Vec4_c(b));
    PB("v4_isnan", a.IsNaN_c());
    PB("v4_isnan_nan", Vec4::sNaN().IsNaN_c());
    PU("v4_sequals", Vec4::sEquals_Vec4_Vec4(a, a));
    PU("v4_sequals2", Vec4::sEquals_Vec4_Vec4(a, b));
    PU("v4_sless", Vec4::sLess_Vec4_Vec4(a, b));
    PU("v4_sgreater", Vec4::sGreater_Vec4_Vec4(a, b));
    P4("v4_sselect", Vec4::sSelect_Vec4_Vec4_UVec4(a, b, m));
    P4("v4_sor", Vec4::sOr_Vec4_Vec4(a, b));
    P4("v4_sand", Vec4::sAnd_Vec4_Vec4(a, b));
    P4("v4_sxor", Vec4::sXor_Vec4_Vec4(a, b));
    PU("v4_reint", a.ReinterpretAsInt_c());
    P4("v4_reint_back", a.ReinterpretAsInt_c().ReinterpretAsFloat_c());
    PU("v4_toint", Vec4::ctor_f32_f32_f32_f32(1.0f32, 2.0f32, 3.0f32, 4.0f32).ToInt_c());
    PB("v4_testalltrue", Vec4::sEquals_Vec4_Vec4(a, a).TestAllTrue_c());
    PB("v4_testalltrue2", Vec4::sEquals_Vec4_Vec4(a, b).TestAllTrue_c());
    PB("v4_testanytrue", Vec4::sEquals_Vec4_Vec4(a, b).TestAnyTrue_c());
    let mut f4: Float4 = Float4::default();
    a.StoreFloat4_mut_Float4_c(&mut f4);
    P4("v4_storefloat4", Vec4::ctor_f32_f32_f32_f32(f4.x, f4.y, f4.z, f4.w));
    P3("v3_szero", Vec3::sZero());
    P3("v3_sone", Vec3::sOne());
    P3("v3_saxisx", Vec3::sAxisX());
    P3("v3_saxisy", Vec3::sAxisY());
    P3("v3_saxisz", Vec3::sAxisZ());
    P3("v3_sreplicate", Vec3::sReplicate_f32(3.25f32));
    P3("v3_ctor", p);
    let mut d: Vec3 = p;
    P3("v3_copyctor", d);
    let mut d: Vec3 = p;
    d.SetY_f32((-7.5f32));
    P3("v3_sety", d);
    let mut d: Vec3 = Vec3::default();
    d = p;
    P3("v3_defaultassign", d);
    let mut d: Vec3 = (Vec3::ctor_Vec4(Vec4::ctor_Vec3_f32(p, 9.0f32)));
    P3("v3_ctor_v4", d);
    let mut f3: Float3 = Float3::default();
    f3.x = 1.0f32;
    f3.y = 2.0f32;
    f3.z = 3.0f32;
    P3("v3_ctor_float3", (Vec3::ctor_Float3(f3) as Vec3));
    PF("v3_getx", p.GetX_c());
    PF("v3_getz", p.GetZ_c());
    let mut d: Vec3 = p;
    d.SetX_f32(5.5f32);
    d.SetZ_f32((-1.25f32));
    P3("v3_setxz", d);
    P3("v3_add", p.op_add_Vec3_c(q));
    P3("v3_sub", p.op_sub_Vec3_c(q));
    P3("v3_neg", p.op_sub_c());
    P3("v3_mulvec", p.op_mul_Vec3_c(q));
    P3("v3_mulfloat", p.op_mul_f32_c(2.5f32));
    P3("v3_divfloat", p.op_div_f32_c(2.0f32));
    let mut d: Vec3 = p;
    d.op_iadd_Vec3(q);
    P3("v3_iadd", d);
    let mut d: Vec3 = p;
    d.op_isub_Vec3(q);
    P3("v3_isub", d);
    let mut d: Vec3 = p;
    d.op_imul_f32(2.0f32);
    P3("v3_imulf", d);
    let mut d: Vec3 = p;
    d.op_idiv_f32(4.0f32);
    P3("v3_idivf", d);
    P3("v3_smin", Vec3::sMin_Vec3_Vec3(p, q));
    P3("v3_smax", Vec3::sMax_Vec3_Vec3(p, q));
    P3("v3_abs", p.Abs_c());
    P3("v3_cross", p.Cross_Vec3_c(q));
    PF("v3_dot", p.Dot_Vec3_c(q));
    P3("v3_dotv", p.DotV_Vec3_c(q));
    PF("v3_length", p.Length_c());
    PF("v3_lengthsq", p.LengthSq_c());
    P3("v3_normalized", p.Normalized_c());
    PF("v3_reducesum", p.ReduceSum_c());
    P3("v3_getsign", p.GetSign_c());
    PB("v3_eq", p.op_eq_Vec3_c(p));
    PB("v3_ne", p.op_ne_Vec3_c(q));
    PB("v3_isnan", p.IsNaN_c());
    PU("u_ctor", m);
    PU("u_szero", UVec4::sZero());
    PU("u_sreplicate", UVec4::sReplicate_u32(0x12345678u32));
    PU("u_or", UVec4::sOr_UVec4_UVec4(m, n));
    PU("u_and", UVec4::sAnd_UVec4_UVec4(m, n));
    PU("u_xor", UVec4::sXor_UVec4_UVec4(m, n));
    PU("u_equals", UVec4::sEquals_UVec4_UVec4(m, n));
    PU("u_smin", UVec4::sMin_UVec4_UVec4(m, n));
    PU("u_smax", UVec4::sMax_UVec4_UVec4(m, n));
    PU("u_select", UVec4::sSelect_UVec4_UVec4_UVec4(m, n, UVec4::ctor_u32_u32_u32_u32(0xffffffffu32, 0u32, 0xffffffffu32, 0u32)));
    PB("u_testalltrue", m.TestAllTrue_c());
    PB("u_testalltrue2", UVec4::ctor_u32_u32_u32_u32(0xffffffffu32, 0xffffffffu32, 0xffffffffu32, 0xffffffffu32).TestAllTrue_c());
    PB("u_testanytrue", n.TestAnyTrue_c());
    PB("u_eq", m.op_eq_UVec4_c(m));
    PB("u_ne", m.op_ne_UVec4_c(n));
    PU("u_not", UVec4::sNot_UVec4(m));
    let mut d: UVec4 = m;
    d.SetX_u32(7u32);
    d.SetW_u32(9u32);
    PU("u_setxw", d);
}

fn main() {
    unsafe { Battery(); }
}

