// battery.cpp — the golden battery: calls every transpiled target function of
// Jolt's math layer (scalar path) and prints every result as raw IEEE-754 bits.
//
// The SAME file is fed through the transpiler (Clang front-end -> IR -> Rust/C#),
// and the transpiled drivers must reproduce this output line-for-line, bit-for-bit.
//
// Compiled ground-truth:  g++ -std=c++17 -O2 -ffp-contract=off -DJPH_PLATFORM_WASM -DNDEBUG
//   (-DJPH_PLATFORM_WASM forces Jolt's portable scalar fallback path: no SSE/NEON/RVV)

#include <Jolt/Jolt.h>

#include <Jolt/Math/Float3.h>
#include <Jolt/Math/Vec3.h>
#include <Jolt/Math/Vec4.h>
#include <Jolt/Math/UVec4.h>

#include <cstdio>

JPH_NAMESPACE_BEGIN

// ---------------------------------------------------------------------------
// Bit-print helpers. printf calls in this file are restricted to the subset
// the front-end understands: "%s" with a literal string, "%08x" / "%u" with a
// uint32 expression, "\n" as newline.
// ---------------------------------------------------------------------------

union FBits {
	float f;
	uint32 u;
};

static unsigned BitsOf(float inF) {
	FBits b;
	b.f = inF;
	return b.u;
}

static void P4(const char *inName, const Vec4 &inV) {
	printf("%s %08x %08x %08x %08x\n", inName,
		BitsOf(inV.GetX()), BitsOf(inV.GetY()), BitsOf(inV.GetZ()), BitsOf(inV.GetW()));
}

static void P3(const char *inName, const Vec3 &inV) {
	printf("%s %08x %08x %08x\n", inName,
		BitsOf(inV.GetX()), BitsOf(inV.GetY()), BitsOf(inV.GetZ()));
}

static void PU(const char *inName, const UVec4 &inV) {
	printf("%s %08x %08x %08x %08x\n", inName,
		inV.GetX(), inV.GetY(), inV.GetZ(), inV.GetW());
}

static void PF(const char *inName, float inF) {
	printf("%s %08x\n", inName, BitsOf(inF));
}

static void PB(const char *inName, bool inB) {
	printf("%s %u\n", inName, inB? 1u : 0u);
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

static void Battery() {
	Vec4 a(1.5f, -2.25f, 0.75f, 4.0f);
	Vec4 b(-0.5f, 3.5f, 2.0f, -1.0f);
	Vec4 c(0.25f, 0.125f, -8.0f, 16.0f);
	Vec3 p(1.5f, -2.0f, 0.25f);
	Vec3 q(-3.0f, 0.5f, 4.0f);
	UVec4 m(0xffffffffu, 0x00000000u, 0x80000000u, 0x00000001u);
	UVec4 n(0x00000001u, 0xffffffffu, 0x80000000u, 0x00000000u);

	// --- Vec4: constructors & factories ---
	P4("v4_szero", Vec4::sZero());
	P4("v4_sone", Vec4::sOne());
	P4("v4_snan", Vec4::sNaN());
	P4("v4_sreplicate", Vec4::sReplicate(2.5f));
	P4("v4_ctor", a);
	{ Vec4 d(a); P4("v4_copyctor", d); }
	{ Vec4 d(p, 7.75f); P4("v4_ctor_v3f", d); }
	{ Vec4 d; d = a; P4("v4_defaultassign", d); }

	// --- Vec4: component access ---
	PF("v4_getx", a.GetX());
	PF("v4_gety", a.GetY());
	PF("v4_getz", a.GetZ());
	PF("v4_getw", a.GetW());
	{ Vec4 d = a; d.SetX(9.5f); d.SetY(-0.125f); P4("v4_setxy", d); }
	{ Vec4 d = a; d.Set(-1.0f, 2.0f, -4.0f, 8.0f); P4("v4_set", d); }
	{ Vec4 d = a; d.SetZ(0.5f); PF("v4_index_get", d[2]); }
	{ Vec4 d = a; d[1] = 6.25f; P4("v4_index_set", d); }

	// --- Vec4: component-wise arithmetic ---
	P4("v4_add", a + b);
	P4("v4_sub", a - b);
	P4("v4_neg", -a);
	P4("v4_mulvec", a * b);
	P4("v4_mulfloat", a * 2.0f);
	P4("v4_mulfloat_friend", 2.0f * a);
	P4("v4_divfloat", a / 4.0f);
	P4("v4_divvec", a / b);
	P4("v4_recip", a.Reciprocal());
	{ Vec4 d = a; d += b; P4("v4_iadd", d); }
	{ Vec4 d = a; d -= b; P4("v4_isub", d); }
	{ Vec4 d = a; d *= 3.0f; P4("v4_imulf", d); }
	{ Vec4 d = a; d *= b; P4("v4_imulv", d); }
	{ Vec4 d = a; d /= 2.0f; P4("v4_idivf", d); }

	// --- Vec4: min/max/clamp/abs ---
	P4("v4_smin", Vec4::sMin(a, b));
	P4("v4_smax", Vec4::sMax(a, b));
	P4("v4_sclamp", Vec4::sClamp(c, a, b));
	P4("v4_abs", a.Abs());

	// --- Vec4: math ---
	P4("v4_sqrt", c.Sqrt());
	PF("v4_length", a.Length());
	PF("v4_lengthsq", a.LengthSq());
	PF("v4_dot", a.Dot(b));
	P4("v4_dotv", a.DotV(b));
	P4("v4_normalized", a.Normalized());
	PF("v4_reducesum", a.ReduceSum());
	PF("v4_reducemin", a.ReduceMin());
	PF("v4_reducemax", a.ReduceMax());
	P4("v4_sfma", Vec4::sFusedMultiplyAdd(a, b, c));
	P4("v4_sdop", Vec4::sDifferenceOfProducts(a, b, c, a));
	P4("v4_getsign", a.GetSign());

	// --- Vec4: comparisons & predicates ---
	PB("v4_eq_true", a == a);
	PB("v4_eq_false", a == b);
	PB("v4_ne", a != b);
	PB("v4_isclose", a.IsClose(a + b * 1.0e-8f));
	PB("v4_isclose_far", a.IsClose(b));
	PB("v4_isnearzero", (a - a).IsNearZero());
	PB("v4_isnormalized", Vec4::sOne().IsNormalized());
	PB("v4_isnan", a.IsNaN());
	PB("v4_isnan_nan", Vec4::sNaN().IsNaN());

	// --- Vec4: bitwise via reinterpretation ---
	PU("v4_sequals", Vec4::sEquals(a, a));
	PU("v4_sequals2", Vec4::sEquals(a, b));
	PU("v4_sless", Vec4::sLess(a, b));
	PU("v4_sgreater", Vec4::sGreater(a, b));
	P4("v4_sselect", Vec4::sSelect(a, b, m));
	P4("v4_sor", Vec4::sOr(a, b));
	P4("v4_sand", Vec4::sAnd(a, b));
	P4("v4_sxor", Vec4::sXor(a, b));
	PU("v4_reint", a.ReinterpretAsInt());
	P4("v4_reint_back", a.ReinterpretAsInt().ReinterpretAsFloat());
	PU("v4_toint", Vec4(1.0f, 2.0f, 3.0f, 4.0f).ToInt());
	PB("v4_testalltrue", Vec4::sEquals(a, a).TestAllTrue());
	PB("v4_testalltrue2", Vec4::sEquals(a, b).TestAllTrue());
	PB("v4_testanytrue", Vec4::sEquals(a, b).TestAnyTrue());

	// --- Vec4: trig-free store ---
	{ Float4 f4; a.StoreFloat4(&f4); P4("v4_storefloat4", Vec4(f4.x, f4.y, f4.z, f4.w)); }

	// --- Vec3: constructors & factories ---
	P3("v3_szero", Vec3::sZero());
	P3("v3_sone", Vec3::sOne());
	P3("v3_saxisx", Vec3::sAxisX());
	P3("v3_saxisy", Vec3::sAxisY());
	P3("v3_saxisz", Vec3::sAxisZ());
	P3("v3_sreplicate", Vec3::sReplicate(3.25f));
	P3("v3_ctor", p);
	{ Vec3 d(p); P3("v3_copyctor", d); }
	{ Vec3 d(p); d.SetY(-7.5f); P3("v3_sety", d); }
	{ Vec3 d; d = p; P3("v3_defaultassign", d); }
	{ Vec3 d(Vec4(p, 9.0f)); P3("v3_ctor_v4", d); }
	{ Float3 f3; f3.x = 1.0f; f3.y = 2.0f; f3.z = 3.0f; P3("v3_ctor_float3", Vec3(f3)); }

	// --- Vec3: component access ---
	PF("v3_getx", p.GetX());
	PF("v3_getz", p.GetZ());
	{ Vec3 d = p; d.SetX(5.5f); d.SetZ(-1.25f); P3("v3_setxz", d); }

	// --- Vec3: arithmetic ---
	P3("v3_add", p + q);
	P3("v3_sub", p - q);
	P3("v3_neg", -p);
	P3("v3_mulvec", p * q);
	P3("v3_mulfloat", p * 2.5f);
	P3("v3_divfloat", p / 2.0f);
	{ Vec3 d = p; d += q; P3("v3_iadd", d); }
	{ Vec3 d = p; d -= q; P3("v3_isub", d); }
	{ Vec3 d = p; d *= 2.0f; P3("v3_imulf", d); }
	{ Vec3 d = p; d /= 4.0f; P3("v3_idivf", d); }

	// --- Vec3: min/max/abs ---
	P3("v3_smin", Vec3::sMin(p, q));
	P3("v3_smax", Vec3::sMax(p, q));
	P3("v3_abs", p.Abs());

	// --- Vec3: vector math ---
	P3("v3_cross", p.Cross(q));
	PF("v3_dot", p.Dot(q));
	P3("v3_dotv", p.DotV(q));
	PF("v3_length", p.Length());
	PF("v3_lengthsq", p.LengthSq());
	P3("v3_normalized", p.Normalized());
	PF("v3_reducesum", p.ReduceSum());
	P3("v3_getsign", p.GetSign());
	PB("v3_eq", p == p);
	PB("v3_ne", p != q);
	PB("v3_isclose", p.IsClose(p));
	PB("v3_isnan", p.IsNaN());

	// --- UVec4 ---
	PU("u_ctor", m);
	PU("u_szero", UVec4::sZero());
	PU("u_sreplicate", UVec4::sReplicate(0x12345678u));
	PU("u_or", UVec4::sOr(m, n));
	PU("u_and", UVec4::sAnd(m, n));
	PU("u_xor", UVec4::sXor(m, n));
	PU("u_equals", UVec4::sEquals(m, n));
	PU("u_smin", UVec4::sMin(m, n));
	PU("u_smax", UVec4::sMax(m, n));
	PU("u_select", UVec4::sSelect(m, n, UVec4(0xffffffffu, 0u, 0xffffffffu, 0u)));
	PB("u_testalltrue", m.TestAllTrue());
	PB("u_testalltrue2", UVec4(0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu).TestAllTrue());
	PB("u_testanytrue", n.TestAnyTrue());
	PB("u_eq", m == m);
	PB("u_ne", m != n);
	PU("u_not", UVec4::sNot(m));
	{ UVec4 d = m; d.SetX(7u); d.SetW(9u); PU("u_setxw", d); }
}

JPH_NAMESPACE_END

int main() {
	JPH::Battery();
	return 0;
}
