const fs = require('fs');
const path = require('path');
const svgo = require('svgo');
const merge = require('webpack-merge');
const util = require('util');
const xmldom = require('xmldom');
const { VAR_NAMESPACE, VAR_NAMESPACE_VALUE, hasVariables, hasVarNamespace, addVarNamespace } = require('./variable-parser');

function createIdGenerator(template) {
    return function(name) {
        const pathname = this.separator ? name.split(/[\/\\]/).join(this.separator) : name;
        const ext = path.extname(name);
        return util.format(template || '%s', path.basename(pathname.replace(/\s+/g, this.whitespace), ext));
    };
}

module.exports = (files = [], options = {}) => {
    options = merge({
        sprite: {
            gutter: 0,
            generate: {
                title: true,
                symbol: true,
                use: false,
                view: false
            },
            id: {
                separator: '-',
                whitespace: '_',
                generator: createIdGenerator('%s')
            }
        },
        output: {
            svg: {
                sizes: false
            },
            svgo: {}
        }
    }, options);

    if (typeof options.sprite.id.generator !== 'function') {
        options.sprite.id.generator = createIdGenerator(
            (typeof options.sprite.id.generator === 'string')
                ? (options.sprite.id.generator + ((options.sprite.id.generator.indexOf('%s') >= 0) ? '' : '%s'))
                : '%s'
        );
    }

    return new Promise((resolve, reject) => {
        // No point in generating when there are no files
        if ( !files.length ) {
            return resolve();
        }

        // Initialize DOM/XML/SVGO
        const DOMParser = new xmldom.DOMParser();
        const XMLSerializer = new xmldom.XMLSerializer();
        const XMLDoc = new xmldom.DOMImplementation().createDocument(null, null, null);
        const SVGOptimizer = new svgo(merge(options.output.svgo, {
            plugins: [
                // Prevent empty var:* attributes from getting removed prematurely
                { removeEmptyAttrs: false },

                // Prevent groups from getting optimized prematurely as they may contain var:* attributes
                { moveGroupAttrsToElems: false },
                { moveGroupAttrsToElems: false },
                { collapseGroups: false },

                // Prevent titles from getting removed prematurely
                { removeTitle: false }
            ]
        }));

        // Create SVG element
        const svg = XMLDoc.createElement('svg');
        const sizes = {
            width: [],
            height: []
        };

        // Add namespaces
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        if ( options.sprite.generate.use ) {
            svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
        }

        Promise.all(files.map((file) => new Promise((resolve) => {
            const id = options.sprite.id.generator(file.name);
            let sprite = fs.readFileSync(file.path, 'utf8');

            if ( options.output.svgo === false ) {
                return resolve({
                    id: id,
                    sprite: sprite
                });
            }

            if ( hasVariables(sprite) && !hasVarNamespace(sprite) ) {
                sprite = addVarNamespace(sprite);
            }

            SVGOptimizer.optimize(sprite).then((output) => resolve({
                file: file.path,
                id: id,
                sprite: output.data
            }));
        }))).then((items) => {
            // Add the xmlns:var attribute when variables are found in any sprite
            if ( hasVariables(items.map((item) => item.sprite).join('\n')) ) {
                svg.setAttribute(`xmlns:${VAR_NAMESPACE}`, VAR_NAMESPACE_VALUE);
            }

            items.forEach((item) => {
                const sprite = DOMParser.parseFromString(item.sprite).documentElement;

                // Attributes that should be transfered to output SVG
                const attributes = Array.from(sprite.attributes).reduce((attributes, attribute) => {
                    // Blacklist several attributes as they'll be added/removed while parsing
                    if ( ['viewbox', 'width', 'height', 'id', 'xmlns'].includes(attribute.name.toLowerCase()) ) {
                        return attributes;
                    }

                    return [...attributes, {
                        name: attribute.name,
                        value: attribute.value
                    }];
                }, []);

                // Add xmlns:* attributes to root SVG
                attributes.forEach((attribute) => {
                    if ( !attribute.name.toLowerCase().startsWith('xmlns:') ) {
                        return;
                    }

                    svg.setAttribute(attribute.name, attribute.value);
                });

                // Get sizes
                let viewbox = (sprite.getAttribute('viewBox') || sprite.getAttribute('viewbox')).split(' ').map((a) => parseFloat(a));
                let width = parseFloat(sprite.getAttribute('width'));
                let height = parseFloat(sprite.getAttribute('height'));

                if ( viewbox.length !== 4 && ( isNaN(width) || isNaN(height) ) ) {
                    return reject(`Invalid SVG '${item.file}'; it's lacking both a viewBox and width/height attributes...`);
                }

                if ( viewbox.length !== 4 ) {
                    viewbox = [0, 0, width, height];
                }

                if ( isNaN(width) ) {
                    width = viewbox[2];
                }

                if ( isNaN(height) ) {
                    height = viewbox[3];
                }

                // Create symbol
                if ( options.sprite.generate.symbol ) {
                    const symbol = XMLDoc.createElement('symbol');

                    // Attributes
                    symbol.setAttribute('id', item.id);
                    symbol.setAttribute('viewBox', viewbox.join(' '));
                    attributes.forEach((attribute) => {
                        if ( !['preserveaspectratio'].includes(attribute.name.toLowerCase()) ) {
                            return;
                        }

                        symbol.setAttribute(attribute.name, attribute.value);
                    });

                    if ( options.sprite.generate.title ) {
                        // Make sure we don't overwrite the existing title
                        const hasTitle = (sprite) => {
                            const titles = Array.from(sprite.childNodes).filter((childNode) => {
                                return childNode.nodeName.toLowerCase() === 'title';
                            });

                            return !!titles.length;
                        };

                        // Add title to improve accessibility
                        if ( !hasTitle(sprite) ) {
                            const title = XMLDoc.createElement('title');
                            title.appendChild(XMLDoc.createTextNode(item.id));
                            symbol.appendChild(title);
                        }
                    }

                    // Clone the original contents of the SVG file into the new symbol
                    Array.from(sprite.childNodes).forEach((childNode) => {
                        symbol.appendChild(childNode);
                    });

                    svg.appendChild(symbol);
                }

                if ( options.sprite.generate.use ) {
                    // Generate <use> elements within spritemap to allow usage within CSS
                    const use = XMLDoc.createElement('use');
                    const y = sizes.height.reduce((a, b) => a + b, 0) + (sizes.height.length * options.sprite.gutter);

                    use.setAttribute('xlink:href', `#${item.id}`);
                    use.setAttribute('x', '0');
                    use.setAttribute('y', y);
                    use.setAttribute('width', width.toString());
                    use.setAttribute('height', height.toString());
                    svg.appendChild(use);
                }

                if ( options.sprite.generate.view ) {
                    // Generate <view> elements within spritemap to allow usage within CSS
                    const view = XMLDoc.createElement('view');
                    const y = sizes.height.reduce((a, b) => a + b, 0) + (sizes.height.length * options.sprite.gutter);

                    // Attributes
                    view.setAttribute('id', item.id);
                    view.setAttribute('viewBox', `0 ${Math.max(0, y - (options.sprite.gutter / 2))} ${width + (options.sprite.gutter / 2)} ${height + (options.sprite.gutter / 2)}`);
                    attributes.forEach((attribute) => {
                        if ( !['preserveaspectratio'].includes(attribute.name.toLowerCase()) ) {
                            return;
                        }

                        view.setAttribute(attribute.name, attribute.value);
                    });

                    svg.appendChild(view);
                }

                // Update sizes
                sizes.width.push(width);
                sizes.height.push(height);
            });

            if ( options.output.svg.sizes ) {
                // Add width/height to spritemap
                svg.setAttribute('width', Math.max.apply(null, sizes.width).toString());
                svg.setAttribute('height', (sizes.height.reduce((a, b) => a + b, 0) + ((sizes.height.length - 1) * options.sprite.gutter)).toString());
            }

            return resolve(XMLSerializer.serializeToString(svg));
        });
    });
};
