zipfiles = \
	bluetooth-generic.zip \
	twitter-account.zip \
	bodytrace-scale.zip \
	heatpad.zip \
	sportradar.zip \
	weather.zip \
	test.zip

all: $(zipfiles)

%.zip: %
	cd $< ; \
	npm install ; \
	zip -r $(abspath $@) *

clean:
	rm -f *.zip
