// Small authored ASCII FBX fixture: transformed triangle, UVs, a material and
// an embedded PNG. Real binary ZIPs are exercised separately with owner data.
export function createWorkerFBXFixture(pngBase64) {
    return new TextEncoder().encode(`; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXVersion: 7400
}
GlobalSettings:  {
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",2
	}
}
Objects:  {
	Geometry: 11, "Geometry::Triangle", "Mesh" {
		Vertices: *9 {
			a: -1,-1,0,1,-1,0,0,1,0
		}
		PolygonVertexIndex: *3 {
			a: 0,1,-3
		}
		LayerElementNormal: 0 {
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "Direct"
			Normals: *9 {
				a: 0,0,1,0,0,1,0,0,1
			}
		}
		LayerElementUV: 0 {
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "Direct"
			UV: *6 {
				a: 0,0,1,0,0.5,1
			}
		}
	}
	Model: 12, "Model::Triangle", "Mesh" {
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",0.25,0,0
			P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,12
			P: "Lcl Scaling", "Lcl Scaling", "", "A",1.2,1,1
		}
	}
	Material: 13, "Material::Surface", "" {
		ShadingModel: "phong"
		Properties70:  {
			P: "DiffuseColor", "Color", "", "A",0.8,0.6,0.4
		}
	}
	Texture: 14, "Texture::Embedded", "" {
		FileName: "fixture.png"
	}
	Video: 15, "Video::Embedded", "Clip" {
		Filename: "fixture.png"
		RelativeFilename: "fixture.png"
		Content: ,
		"${pngBase64}"
	}
}
Connections:  {
	C: "OO",11,12
	C: "OO",12,0
	C: "OO",13,12
	C: "OP",14,13,"DiffuseColor"
	C: "OO",15,14
}
`).buffer;
}
