"""Export the Android app's VectorDrawable as a release preview, without separate artwork."""
import re
import xml.etree.ElementTree as ET

ANDROID = "{http://schemas.android.com/apk/res/android}"
SVG = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG)

def export_app_icon(module, destination):
    app = ET.parse(module / "src/main/AndroidManifest.xml").getroot().find("application")
    reference = app.get(ANDROID + "icon") if app is not None else None
    if reference is None:
        return False
    if not re.fullmatch(r"@drawable/[a-z0-9_]+", reference):
        raise ValueError("App icon preview requires a drawable resource")
    vector = ET.parse(module / ("src/main/res/drawable/" + reference.split("/")[1] + ".xml")).getroot()
    if vector.tag != "vector":
        raise ValueError("App icon preview requires a VectorDrawable")
    def attr(node, name, default=None):
        return node.get(ANDROID + name, default)
    def element(parent, tag, **attributes):
        return ET.SubElement(parent, "{" + SVG + "}" + tag, attributes)
    def color(value):
        if not re.fullmatch(r"#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?", value):
            raise ValueError("App icon colors must be literal RGB or ARGB")
        return ("#" + value[3:], int(value[1:3], 16) / 255) if len(value) == 9 else (value, 1)
    root = ET.Element("{" + SVG + "}svg", {
        "viewBox": "0 0 " + attr(vector, "viewportWidth") + " " + attr(vector, "viewportHeight"),
        "width": attr(vector, "viewportWidth"), "height": attr(vector, "viewportHeight"),
        "opacity": attr(vector, "alpha", "1")})
    definitions = element(root, "defs")
    gradient_index = 0
    def draw(node, parent):
        nonlocal gradient_index
        if node.tag == "group":
            px, py = attr(node, "pivotX", "0"), attr(node, "pivotY", "0")
            group = element(parent, "g", transform=(
                f"translate({attr(node, 'translateX', '0')} {attr(node, 'translateY', '0')}) "
                f"translate({px} {py}) rotate({attr(node, 'rotation', '0')}) "
                f"scale({attr(node, 'scaleX', '1')} {attr(node, 'scaleY', '1')}) translate({-float(px)} {-float(py)})"))
            for child in node: draw(child, group)
        elif node.tag == "path":
            if any(attr(node, key) not in (None, default) for key, default in
                   (("trimPathStart", "0"), ("trimPathEnd", "1"), ("trimPathOffset", "0"))):
                raise ValueError("Trimmed icon paths need an updated preview exporter")
            path = element(parent, "path", d=attr(node, "pathData"), fill="none")
            for paint in ("fill", "stroke"):
                value = attr(node, paint + "Color")
                alpha = float(attr(node, paint + "Alpha", "1"))
                if value:
                    rgb, opacity = color(value)
                    path.set(paint, rgb)
                    path.set(paint + "-opacity", str(opacity * alpha))
                for wrapper in node:
                    if wrapper.get("name") not in ("android:fillColor", "android:strokeColor"):
                        raise ValueError("Unsupported app icon paint")
                    if wrapper.get("name") != "android:" + paint + "Color":
                        continue
                    gradient = wrapper.find("gradient")
                    if gradient is None:
                        raise ValueError("Unsupported app icon gradient")
                    gradient_index += 1
                    identity = "app-gradient-" + str(gradient_index)
                    kind = attr(gradient, "type", "linear")
                    if kind == "linear":
                        stops = element(definitions, "linearGradient", id=identity, gradientUnits="userSpaceOnUse",
                            x1=attr(gradient, "startX", "0"), y1=attr(gradient, "startY", "0"),
                            x2=attr(gradient, "endX", "0"), y2=attr(gradient, "endY", "0"))
                    elif kind == "radial":
                        stops = element(definitions, "radialGradient", id=identity, gradientUnits="userSpaceOnUse",
                            cx=attr(gradient, "centerX", "0"), cy=attr(gradient, "centerY", "0"),
                            r=attr(gradient, "gradientRadius"))
                    else:
                        raise ValueError("Unsupported app icon gradient type")
                    for stop in gradient:
                        rgb, opacity = color(attr(stop, "color"))
                        element(stops, "stop", offset=attr(stop, "offset"), **{"stop-color": rgb, "stop-opacity": str(opacity)})
                    path.set(paint, "url(#" + identity + ")")
                    path.set(paint + "-opacity", str(alpha))
            for source, target in (("strokeWidth", "stroke-width"), ("strokeLineCap", "stroke-linecap"),
                                   ("strokeLineJoin", "stroke-linejoin"), ("strokeMiterLimit", "stroke-miterlimit")):
                if attr(node, source) is not None: path.set(target, attr(node, source))
            path.set("fill-rule", "evenodd" if attr(node, "fillType") == "evenOdd" else "nonzero")
        else:
            raise ValueError("Unsupported app icon element: " + node.tag)
    for child in vector: draw(child, root)
    ET.ElementTree(root).write(destination, encoding="utf-8", xml_declaration=True)
    return True
